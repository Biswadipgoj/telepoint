-- ============================================================
-- EMI PORTAL — EXISTING SUPABASE UPGRADE
-- Safe to paste into Supabase → SQL Editor → Run
-- Does NOT drop tables, user data, or customer/payment records.
-- Uses IF NOT EXISTS everywhere. Idempotent.
-- ============================================================

-- ============================================================
-- SECTION 1: EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- SECTION 2: FIX CUSTOMER STATUS CONSTRAINT
-- Adds SETTLED and NPA to allowed values
-- ============================================================
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE customers
  ADD CONSTRAINT customers_status_check
  CHECK (status IN ('RUNNING', 'COMPLETE', 'SETTLED', 'NPA'));

-- ============================================================
-- SECTION 3: FIX EMI SCHEDULE STATUS CONSTRAINT
-- Adds PARTIALLY_PAID to allowed values
-- ============================================================
DO $$
BEGIN
  ALTER TABLE emi_schedule DROP CONSTRAINT IF EXISTS emi_schedule_status_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
ALTER TABLE emi_schedule
  ADD CONSTRAINT emi_schedule_status_check
  CHECK (status IN ('UNPAID', 'PENDING_APPROVAL', 'PARTIALLY_PAID', 'APPROVED'));

-- ============================================================
-- SECTION 4: ADD MISSING COLUMNS (all idempotent)
-- ============================================================

-- retailers
ALTER TABLE retailers ADD COLUMN IF NOT EXISTS retail_pin TEXT;
ALTER TABLE retailers ADD COLUMN IF NOT EXISTS mobile     TEXT;

-- customers
ALTER TABLE customers ADD COLUMN IF NOT EXISTS emi_start_date          DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS emi_card_photo_url       TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_locked                BOOLEAN DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lock_provider            TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lock_device_id           TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_drive_docs        TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS settlement_amount        NUMERIC(12,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS settlement_date          DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS settled_by               UUID REFERENCES auth.users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_photo_url       TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS aadhaar_front_url        TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS aadhaar_back_url         TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bill_photo_url           TEXT;

-- emi_schedule
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS partial_paid_amount  NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS partial_paid_at      TIMESTAMPTZ;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS fine_paid_amount     NUMERIC(12,2) DEFAULT 0;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS fine_paid_at         TIMESTAMPTZ;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS fine_last_calculated_at TIMESTAMPTZ;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS utr                  TEXT;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS collected_by_role    TEXT
  CHECK (collected_by_role IN ('admin', 'retailer'));
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS collected_by_user_id UUID
  REFERENCES auth.users(id);

-- fine_settings
ALTER TABLE fine_settings ADD COLUMN IF NOT EXISTS weekly_fine_increment NUMERIC(12,2) DEFAULT 25;
ALTER TABLE fine_settings ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id);
-- Ensure the singleton row exists
INSERT INTO fine_settings (id, default_fine_amount, weekly_fine_increment)
VALUES (1, 450, 25)
ON CONFLICT DO NOTHING;

-- payment_requests
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS utr                     TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS selected_emi_nos        INT[];
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS scheduled_emi_amount    NUMERIC(12,2) DEFAULT 0;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS fine_for_emi_no         INT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS fine_due_date           DATE;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS collected_by_role       TEXT
  CHECK (collected_by_role IN ('admin', 'retailer'));
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS collected_by_user_id    UUID
  REFERENCES auth.users(id);
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS rejected_by             UUID
  REFERENCES auth.users(id);
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS rejected_at             TIMESTAMPTZ;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS rejection_reason        TEXT;

-- ============================================================
-- SECTION 5: CREATE MISSING TABLES
-- ============================================================

-- BROADCAST MESSAGES
CREATE TABLE IF NOT EXISTS broadcast_messages (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_retailer_id UUID REFERENCES retailers(id) ON DELETE CASCADE,
  message            TEXT NOT NULL,
  image_url          TEXT,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_by         UUID REFERENCES auth.users(id),
  sender_name        TEXT DEFAULT 'TELEPOINT',
  sender_role        TEXT DEFAULT 'admin',
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS image_url    TEXT;
ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS sender_name  TEXT DEFAULT 'TELEPOINT';
ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS sender_role  TEXT DEFAULT 'admin';

-- CUSTOMER APP TOKENS
CREATE TABLE IF NOT EXISTS customer_app_tokens (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id      UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  token            TEXT NOT NULL UNIQUE,
  is_active        BOOLEAN DEFAULT TRUE,
  created_by       UUID REFERENCES auth.users(id),
  last_accessed_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- AUDIT LOG (if not exists)
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id UUID REFERENCES auth.users(id),
  actor_role    TEXT,
  action        TEXT NOT NULL,
  table_name    TEXT,
  record_id     UUID,
  before_data   JSONB,
  after_data    JSONB,
  remark        TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- FINE HISTORY
CREATE TABLE IF NOT EXISTS fine_history (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  emi_schedule_id  UUID REFERENCES emi_schedule(id),
  emi_no           INT,
  fine_type        TEXT NOT NULL CHECK (fine_type IN ('BASE', 'WEEKLY', 'PAID', 'WAIVED')),
  fine_amount      NUMERIC(12,2) NOT NULL,
  cumulative_fine  NUMERIC(12,2) NOT NULL DEFAULT 0,
  fine_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  reason           TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- SECTION 6: BACKFILL DATA (safe, idempotent)
-- ============================================================

-- Backfill partial_paid_amount for already-APPROVED EMIs
UPDATE emi_schedule
SET partial_paid_amount = amount
WHERE status = 'APPROVED' AND COALESCE(partial_paid_amount, 0) = 0 AND amount > 0;

-- Normalize impossible partial states
UPDATE emi_schedule
SET
  status = CASE
    WHEN COALESCE(partial_paid_amount, 0) >= amount AND amount > 0 THEN 'APPROVED'
    WHEN COALESCE(partial_paid_amount, 0) > 0 AND COALESCE(partial_paid_amount, 0) < amount THEN 'PARTIALLY_PAID'
    ELSE status
  END
WHERE status NOT IN ('UNPAID', 'PENDING_APPROVAL') OR COALESCE(partial_paid_amount, 0) > 0;

-- Backfill payment_request_items for requests that predate the items table
INSERT INTO payment_request_items (payment_request_id, emi_schedule_id, emi_no, amount)
SELECT
  pr.id AS payment_request_id,
  es.id AS emi_schedule_id,
  es.emi_no,
  pr.total_emi_amount / GREATEST(array_length(pr.selected_emi_nos, 1), 1) AS amount
FROM payment_requests pr
JOIN LATERAL UNNEST(pr.selected_emi_nos) AS sn(emi_no) ON TRUE
JOIN emi_schedule es
  ON es.customer_id = pr.customer_id AND es.emi_no = sn.emi_no
WHERE pr.selected_emi_nos IS NOT NULL
  AND array_length(pr.selected_emi_nos, 1) > 0
  AND NOT EXISTS (
    SELECT 1 FROM payment_request_items pri WHERE pri.payment_request_id = pr.id
  )
ON CONFLICT DO NOTHING;

-- ============================================================
-- SECTION 7: INDEXES (all idempotent)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_customers_imei           ON customers(imei);
CREATE INDEX IF NOT EXISTS idx_customers_aadhaar         ON customers(aadhaar);
CREATE INDEX IF NOT EXISTS idx_customers_mobile          ON customers(mobile);
CREATE INDEX IF NOT EXISTS idx_customers_retailer_id     ON customers(retailer_id);
CREATE INDEX IF NOT EXISTS idx_customers_status          ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_name_trgm       ON customers USING gin(customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_emi_customer_id           ON emi_schedule(customer_id);
CREATE INDEX IF NOT EXISTS idx_emi_due_date              ON emi_schedule(due_date);
CREATE INDEX IF NOT EXISTS idx_emi_status                ON emi_schedule(status);
CREATE INDEX IF NOT EXISTS idx_payment_req_customer      ON payment_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_req_retailer      ON payment_requests(retailer_id);
CREATE INDEX IF NOT EXISTS idx_payment_req_status        ON payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_payment_req_approved_at   ON payment_requests(approved_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_retailer        ON broadcast_messages(target_retailer_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_expires         ON broadcast_messages(expires_at);
CREATE INDEX IF NOT EXISTS idx_customer_tokens_token     ON customer_app_tokens(token);

-- ============================================================
-- SECTION 8: UPDATE HELPER FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION get_my_role()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT role FROM profiles WHERE user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION get_my_retailer_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT id FROM retailers WHERE auth_user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION get_due_breakdown(
  p_customer_id     UUID,
  p_selected_emi_no INT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_customer         RECORD;
  v_next_emi         RECORD;
  v_selected_emi     RECORD;
  v_emi_amount       NUMERIC := 0;
  v_fine_due         NUMERIC := 0;
  v_first_charge_due NUMERIC := 0;
  v_fine_row         RECORD;
  v_base_fine        NUMERIC := 450;
  v_weekly           NUMERIC := 25;
  v_days             INT;
  v_weeks            INT;
  v_calc_fine        NUMERIC;
  v_max_emi_no       INT;
  v_is_overdue       BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(default_fine_amount, 450), COALESCE(weekly_fine_increment, 25)
  INTO v_base_fine, v_weekly
  FROM fine_settings WHERE id = 1;

  SELECT * INTO v_next_emi
  FROM emi_schedule
  WHERE customer_id = p_customer_id
    AND status IN ('UNPAID', 'PARTIALLY_PAID')
  ORDER BY emi_no ASC LIMIT 1;

  IF p_selected_emi_no IS NOT NULL THEN
    SELECT * INTO v_selected_emi
    FROM emi_schedule
    WHERE customer_id = p_customer_id AND emi_no = p_selected_emi_no AND status = 'UNPAID';
    IF FOUND THEN v_emi_amount := v_selected_emi.amount; END IF;
  ELSE
    v_emi_amount := GREATEST(0,
      COALESCE(v_next_emi.amount, 0) - COALESCE(v_next_emi.partial_paid_amount, 0)
    );
  END IF;

  SELECT MAX(emi_no) INTO v_max_emi_no FROM emi_schedule WHERE customer_id = p_customer_id;

  FOR v_fine_row IN
    SELECT * FROM emi_schedule
    WHERE customer_id = p_customer_id
      AND status IN ('UNPAID', 'PARTIALLY_PAID')
      AND due_date < CURRENT_DATE
      AND fine_waived = FALSE
  LOOP
    v_days := GREATEST(0, (CURRENT_DATE - v_fine_row.due_date)::INT);
    IF v_fine_row.emi_no = v_max_emi_no THEN
      v_calc_fine := CEIL(GREATEST(1, v_days)::NUMERIC / 30) * v_base_fine;
    ELSIF v_days <= 30 THEN
      v_calc_fine := v_base_fine;
    ELSE
      v_weeks := FLOOR((v_days - 30)::NUMERIC / 7);
      v_calc_fine := v_base_fine + (v_weeks * v_weekly);
    END IF;
    v_calc_fine := GREATEST(v_calc_fine, COALESCE(v_fine_row.fine_amount, 0));
    v_fine_due  := v_fine_due + GREATEST(0, v_calc_fine - COALESCE(v_fine_row.fine_paid_amount, 0));
    v_is_overdue := TRUE;
  END LOOP;

  IF COALESCE(v_customer.first_emi_charge_amount, 0) > 0
     AND v_customer.first_emi_charge_paid_at IS NULL THEN
    v_first_charge_due := v_customer.first_emi_charge_amount;
  END IF;

  RETURN jsonb_build_object(
    'customer_id',          p_customer_id,
    'customer_status',      v_customer.status,
    'next_emi_no',          v_next_emi.emi_no,
    'next_emi_amount',      COALESCE(v_next_emi.amount, 0),
    'next_emi_due_date',    v_next_emi.due_date,
    'next_emi_status',      v_next_emi.status,
    'selected_emi_no',      COALESCE(p_selected_emi_no, v_next_emi.emi_no),
    'selected_emi_amount',  v_emi_amount,
    'fine_due',             v_fine_due,
    'first_emi_charge_due', v_first_charge_due,
    'total_payable',        v_emi_amount + v_fine_due + v_first_charge_due,
    'popup_first_emi_charge', v_first_charge_due > 0,
    'popup_fine_due',         v_fine_due > 0,
    'is_overdue',             v_is_overdue
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Atomic payment approval RPC
CREATE OR REPLACE FUNCTION approve_payment_request(
  p_request_id UUID,
  p_admin_id   UUID,
  p_remark     TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_request     RECORD;
  v_item        RECORD;
  v_now         TIMESTAMPTZ := NOW();
  v_emi_ids     UUID[] := '{}';
  v_unpaid_count INT;
BEGIN
  SELECT * INTO v_request FROM payment_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request not found');
  END IF;
  IF v_request.status = 'APPROVED' THEN
    RETURN jsonb_build_object('success', true, 'already_approved', true, 'request_id', p_request_id);
  END IF;
  IF v_request.status != 'PENDING' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot approve: status is ' || v_request.status);
  END IF;

  FOR v_item IN
    SELECT pri.emi_schedule_id, pri.amount, es.amount AS emi_amount,
           COALESCE(es.partial_paid_amount, 0) AS already_paid
    FROM payment_request_items pri
    JOIN emi_schedule es ON es.id = pri.emi_schedule_id
    WHERE pri.payment_request_id = p_request_id
  LOOP
    DECLARE
      v_new_paid NUMERIC;
      v_is_full  BOOLEAN;
    BEGIN
      v_new_paid := LEAST(v_item.emi_amount, v_item.already_paid + v_item.amount);
      v_is_full  := v_new_paid >= v_item.emi_amount;
      UPDATE emi_schedule
      SET
        partial_paid_amount  = v_new_paid,
        partial_paid_at      = COALESCE(partial_paid_at, v_now),
        status               = CASE WHEN v_is_full THEN 'APPROVED' ELSE 'PARTIALLY_PAID' END,
        paid_at              = CASE WHEN v_is_full THEN COALESCE(paid_at, v_now) ELSE NULL END,
        mode                 = COALESCE(mode, v_request.mode),
        utr                  = COALESCE(utr, v_request.utr),
        approved_by          = p_admin_id,
        collected_by_role    = COALESCE(collected_by_role, v_request.collected_by_role, 'retailer'),
        collected_by_user_id = COALESCE(collected_by_user_id, v_request.submitted_by),
        updated_at           = v_now
      WHERE id = v_item.emi_schedule_id;
      v_emi_ids := v_emi_ids || v_item.emi_schedule_id;
    END;
  END LOOP;

  IF COALESCE(v_request.fine_amount, 0) > 0 THEN
    UPDATE emi_schedule
    SET
      fine_paid_amount = LEAST(fine_amount,
        COALESCE(fine_paid_amount, 0) + v_request.fine_amount),
      fine_paid_at = COALESCE(fine_paid_at, v_now),
      updated_at   = v_now
    WHERE customer_id = v_request.customer_id
      AND emi_no = COALESCE(v_request.fine_for_emi_no,
        (SELECT MIN(pri.emi_no) FROM payment_request_items pri
         WHERE pri.payment_request_id = p_request_id));
  END IF;

  IF COALESCE(v_request.first_emi_charge_amount, 0) > 0 THEN
    UPDATE customers
    SET first_emi_charge_paid_at = COALESCE(first_emi_charge_paid_at, v_now),
        updated_at = v_now
    WHERE id = v_request.customer_id;
  END IF;

  UPDATE payment_requests
  SET status = 'APPROVED', approved_by = p_admin_id, approved_at = v_now, updated_at = v_now,
      notes = CASE
                WHEN p_remark IS NOT NULL
                THEN COALESCE(notes || E'\n', '') || 'Admin remark: ' || p_remark
                ELSE notes END
  WHERE id = p_request_id;

  SELECT COUNT(*) INTO v_unpaid_count
  FROM emi_schedule
  WHERE customer_id = v_request.customer_id
    AND status IN ('UNPAID', 'PENDING_APPROVAL', 'PARTIALLY_PAID');

  IF v_unpaid_count = 0 THEN
    DECLARE v_cust RECORD; v_fine_pending BOOLEAN; v_charge_pending BOOLEAN;
    BEGIN
      SELECT * INTO v_cust FROM customers WHERE id = v_request.customer_id;
      v_fine_pending := EXISTS (
        SELECT 1 FROM emi_schedule
        WHERE customer_id = v_request.customer_id AND fine_waived = FALSE
          AND fine_amount > COALESCE(fine_paid_amount, 0)
      );
      v_charge_pending := COALESCE(v_cust.first_emi_charge_amount, 0) > 0
                       AND v_cust.first_emi_charge_paid_at IS NULL;
      IF NOT v_fine_pending AND NOT v_charge_pending THEN
        UPDATE customers SET status = 'COMPLETE', completion_date = v_now::DATE, updated_at = v_now
        WHERE id = v_request.customer_id AND status = 'RUNNING';
      END IF;
    END;
  END IF;

  INSERT INTO audit_log (actor_user_id, actor_role, action, table_name, record_id, before_data, after_data, remark)
  VALUES (p_admin_id, 'super_admin', 'APPROVE_PAYMENT', 'payment_requests', p_request_id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object('status', 'APPROVED', 'emi_ids', to_jsonb(v_emi_ids), 'approved_at', v_now),
    p_remark);

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id,
    'emi_ids', to_jsonb(v_emi_ids), 'approved_at', v_now);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- SECTION 9: DISABLE LEGACY TRIGGER (replaced by API-side logic)
-- ============================================================
DROP TRIGGER IF EXISTS trg_auto_apply              ON payment_requests;
DROP TRIGGER IF EXISTS trg_auto_apply_payment_on_approval ON payment_requests;
DROP FUNCTION IF EXISTS fn_auto_apply_payment_on_approval();

-- ============================================================
-- SECTION 10: RLS — ensure enabled on all tables
-- ============================================================
ALTER TABLE profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE retailers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE emi_schedule          ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE fine_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_app_tokens   ENABLE ROW LEVEL SECURITY;
ALTER TABLE fine_history          ENABLE ROW LEVEL SECURITY;

-- Re-create all policies (drop first for idempotency)
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, pol.tablename);
  END LOOP;
END;
$$;

-- PROFILES
CREATE POLICY "profiles_self"      ON profiles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "profiles_admin_all" ON profiles FOR ALL    USING (get_my_role() = 'super_admin');

-- RETAILERS
CREATE POLICY "retailers_admin_all" ON retailers FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "retailers_self_read" ON retailers FOR SELECT USING (auth_user_id = auth.uid());

-- CUSTOMERS
CREATE POLICY "customers_admin_all"    ON customers FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "customers_retailer_own" ON customers FOR SELECT USING (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id());
CREATE POLICY "customers_retailer_ins" ON customers FOR INSERT WITH CHECK (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id());
CREATE POLICY "customers_retailer_upd" ON customers FOR UPDATE USING (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id());

-- EMI SCHEDULE
CREATE POLICY "emi_admin_all"    ON emi_schedule FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "emi_retailer_own" ON emi_schedule FOR SELECT USING (
  get_my_role() = 'retailer' AND
  customer_id IN (SELECT id FROM customers WHERE retailer_id = get_my_retailer_id()));

-- PAYMENT REQUESTS
CREATE POLICY "payment_requests_admin_all"    ON payment_requests FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "payment_requests_retailer_own" ON payment_requests FOR SELECT USING (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id());
CREATE POLICY "payment_requests_retailer_ins" ON payment_requests FOR INSERT WITH CHECK (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id());

-- PAYMENT REQUEST ITEMS
CREATE POLICY "payment_items_admin"    ON payment_request_items FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "payment_items_retailer" ON payment_request_items FOR SELECT USING (
  get_my_role() = 'retailer' AND
  payment_request_id IN (SELECT id FROM payment_requests WHERE retailer_id = get_my_retailer_id()));
CREATE POLICY "payment_items_ins"      ON payment_request_items FOR INSERT WITH CHECK (
  get_my_role() IN ('super_admin', 'retailer'));

-- AUDIT LOG
CREATE POLICY "audit_admin_read" ON audit_log FOR SELECT USING (get_my_role() = 'super_admin');
CREATE POLICY "audit_service_ins" ON audit_log FOR INSERT  WITH CHECK (TRUE);

-- FINE SETTINGS
CREATE POLICY "fine_settings_admin" ON fine_settings FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "fine_settings_read"  ON fine_settings FOR SELECT USING (auth.uid() IS NOT NULL);

-- BROADCAST MESSAGES
CREATE POLICY "broadcast_admin_all"     ON broadcast_messages FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "broadcast_retailer_read" ON broadcast_messages FOR SELECT USING (
  get_my_role() = 'retailer' AND
  (target_retailer_id = get_my_retailer_id() OR target_retailer_id IS NULL));

-- CUSTOMER APP TOKENS
CREATE POLICY "cat_admin_all"      ON customer_app_tokens FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "cat_retailer_read"  ON customer_app_tokens FOR SELECT USING (
  get_my_role() = 'retailer' AND
  customer_id IN (SELECT id FROM customers WHERE retailer_id = get_my_retailer_id()));

-- FINE HISTORY
CREATE POLICY "fine_history_admin" ON fine_history FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "fine_history_read"  ON fine_history FOR SELECT USING (
  get_my_role() = 'retailer' AND
  customer_id IN (SELECT id FROM customers WHERE retailer_id = get_my_retailer_id()));

-- ============================================================
-- SECTION 11: GRANTS
-- ============================================================
GRANT EXECUTE ON FUNCTION get_my_role()                              TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_retailer_id()                       TO authenticated;
GRANT EXECUTE ON FUNCTION get_due_breakdown(UUID, INT)               TO authenticated;
GRANT EXECUTE ON FUNCTION approve_payment_request(UUID, UUID, TEXT)  TO service_role;

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- DONE
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE '================================================';
  RAISE NOTICE 'EMI Portal UPGRADE complete.';
  RAISE NOTICE 'All columns/tables added safely.';
  RAISE NOTICE 'RLS policies refreshed.';
  RAISE NOTICE 'Functions updated.';
  RAISE NOTICE 'Legacy triggers removed.';
  RAISE NOTICE '================================================';
END $$;
