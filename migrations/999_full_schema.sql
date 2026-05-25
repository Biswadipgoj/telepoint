-- ============================================================
-- EMI PORTAL — COMPLETE SUPABASE SQL
-- Run this entire file in Supabase → SQL Editor → Run
-- Safe to run on a fresh DB or an existing one (idempotent)
-- ============================================================


-- ============================================================
-- SECTION 1: EXTENSIONS
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================
-- SECTION 2: TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS profiles (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('super_admin', 'retailer')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS retailers (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  username     TEXT UNIQUE NOT NULL,
  retail_pin   TEXT,
  mobile       TEXT,
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  retailer_id              UUID NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  customer_name            TEXT NOT NULL,
  father_name              TEXT,
  aadhaar                  TEXT CHECK (LENGTH(aadhaar) = 12),
  voter_id                 TEXT,
  address                  TEXT,
  landmark                 TEXT,
  mobile                   TEXT NOT NULL CHECK (LENGTH(mobile) = 10),
  alternate_number_1       TEXT,
  alternate_number_2       TEXT,
  model_no                 TEXT,
  imei                     TEXT UNIQUE NOT NULL CHECK (LENGTH(imei) = 15),
  purchase_value           NUMERIC(12,2) NOT NULL,
  down_payment             NUMERIC(12,2) DEFAULT 0,
  disburse_amount          NUMERIC(12,2),
  purchase_date            DATE NOT NULL,
  emi_due_day              INT CHECK (emi_due_day BETWEEN 1 AND 28),
  emi_amount               NUMERIC(12,2) NOT NULL,
  emi_tenure               INT NOT NULL CHECK (emi_tenure BETWEEN 1 AND 12),
  first_emi_charge_amount  NUMERIC(12,2) DEFAULT 0,
  first_emi_charge_paid_at TIMESTAMPTZ,
  box_no                   TEXT,
  -- Image URLs
  customer_photo_url       TEXT,
  aadhaar_front_url        TEXT,
  aadhaar_back_url         TEXT,
  bill_photo_url           TEXT,
  -- Legacy columns (keep for backwards compat)
  photo_url                TEXT,
  bill_url                 TEXT,
  card_url                 TEXT,
  -- Status
  status             TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETE')),
  completion_remark  TEXT,
  completion_date    DATE,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS emi_schedule (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id          UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  emi_no               INT NOT NULL,
  due_date             DATE NOT NULL,
  amount               NUMERIC(12,2) NOT NULL,
  status               TEXT NOT NULL DEFAULT 'UNPAID'
                         CHECK (status IN ('UNPAID', 'PENDING_APPROVAL', 'APPROVED')),
  paid_at              TIMESTAMPTZ,
  mode                 TEXT CHECK (mode IN ('CASH', 'UPI')),
  approved_by          UUID REFERENCES auth.users(id),
  fine_amount          NUMERIC(12,2) DEFAULT 0,
  fine_waived          BOOLEAN DEFAULT FALSE,
  collected_by_role    TEXT CHECK (collected_by_role IN ('admin', 'retailer')),
  collected_by_user_id UUID REFERENCES auth.users(id),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, emi_no)
);

CREATE TABLE IF NOT EXISTS payment_requests (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id             UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  retailer_id             UUID NOT NULL REFERENCES retailers(id),
  submitted_by            UUID REFERENCES auth.users(id),
  status                  TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  mode                    TEXT NOT NULL CHECK (mode IN ('CASH', 'UPI')),
  total_emi_amount        NUMERIC(12,2) DEFAULT 0,
  scheduled_emi_amount    NUMERIC(12,2) DEFAULT 0,
  fine_amount             NUMERIC(12,2) DEFAULT 0,
  first_emi_charge_amount NUMERIC(12,2) DEFAULT 0,
  total_amount            NUMERIC(12,2) NOT NULL,
  receipt_url             TEXT,
  notes                   TEXT,
  selected_emi_nos        INT[],
  fine_for_emi_no         INT,
  fine_due_date           DATE,
  collected_by_role       TEXT CHECK (collected_by_role IN ('admin', 'retailer')),
  collected_by_user_id    UUID REFERENCES auth.users(id),
  approved_by             UUID REFERENCES auth.users(id),
  approved_at             TIMESTAMPTZ,
  rejected_by             UUID REFERENCES auth.users(id),
  rejected_at             TIMESTAMPTZ,
  rejection_reason        TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- CRITICAL: column name is emi_schedule_id (NOT emi_id)
CREATE TABLE IF NOT EXISTS payment_request_items (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_request_id UUID NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  emi_schedule_id    UUID NOT NULL REFERENCES emi_schedule(id),
  emi_no             INT NOT NULL,
  amount             NUMERIC(12,2) NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS fine_settings (
  id                  INT PRIMARY KEY DEFAULT 1,
  default_fine_amount NUMERIC(12,2) DEFAULT 450,
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_by          UUID REFERENCES auth.users(id),
  CHECK (id = 1)
);

INSERT INTO fine_settings (id, default_fine_amount)
VALUES (1, 450)
ON CONFLICT DO NOTHING;


-- ============================================================
-- SECTION 3: ALTER TABLE (safe — IF NOT EXISTS / IF NOT EXISTS)
-- ============================================================

ALTER TABLE retailers          ADD COLUMN IF NOT EXISTS retail_pin TEXT;
ALTER TABLE retailers          ADD COLUMN IF NOT EXISTS mobile TEXT;
ALTER TABLE emi_schedule       ADD COLUMN IF NOT EXISTS collected_by_role TEXT
  CHECK (collected_by_role IN ('admin', 'retailer'));
ALTER TABLE emi_schedule       ADD COLUMN IF NOT EXISTS collected_by_user_id UUID
  REFERENCES auth.users(id);
ALTER TABLE customers          ADD COLUMN IF NOT EXISTS customer_photo_url TEXT;
ALTER TABLE customers          ADD COLUMN IF NOT EXISTS aadhaar_front_url TEXT;
ALTER TABLE customers          ADD COLUMN IF NOT EXISTS aadhaar_back_url TEXT;
ALTER TABLE customers          ADD COLUMN IF NOT EXISTS bill_photo_url TEXT;
ALTER TABLE payment_requests   ADD COLUMN IF NOT EXISTS selected_emi_nos INT[];
ALTER TABLE payment_requests   ADD COLUMN IF NOT EXISTS scheduled_emi_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE payment_requests   ADD COLUMN IF NOT EXISTS collected_by_role TEXT CHECK (collected_by_role IN ('admin', 'retailer'));
ALTER TABLE payment_requests   ADD COLUMN IF NOT EXISTS collected_by_user_id UUID REFERENCES auth.users(id);
ALTER TABLE payment_requests   ADD COLUMN IF NOT EXISTS fine_for_emi_no INT;
ALTER TABLE payment_requests   ADD COLUMN IF NOT EXISTS fine_due_date DATE;


-- ============================================================
-- SECTION 4: INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_customers_imei          ON customers(imei);
CREATE INDEX IF NOT EXISTS idx_customers_aadhaar        ON customers(aadhaar);
CREATE INDEX IF NOT EXISTS idx_customers_mobile         ON customers(mobile);
CREATE INDEX IF NOT EXISTS idx_customers_retailer_id    ON customers(retailer_id);
CREATE INDEX IF NOT EXISTS idx_customers_status         ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_name           ON customers
  USING gin(to_tsvector('english', customer_name));
CREATE INDEX IF NOT EXISTS idx_emi_schedule_customer_id ON emi_schedule(customer_id);
CREATE INDEX IF NOT EXISTS idx_emi_schedule_due_date    ON emi_schedule(due_date);
CREATE INDEX IF NOT EXISTS idx_emi_schedule_status      ON emi_schedule(status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_customer_id ON payment_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_retailer_id ON payment_requests(retailer_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status  ON payment_requests(status);
CREATE INDEX IF NOT EXISTS idx_pri_payment_request_id   ON payment_request_items(payment_request_id);
CREATE INDEX IF NOT EXISTS idx_pri_emi_schedule_id      ON payment_request_items(emi_schedule_id);


-- ============================================================
-- SECTION 5: HELPER FUNCTIONS
-- ============================================================

CREATE OR REPLACE FUNCTION get_my_role()
RETURNS TEXT AS $$
  SELECT role FROM profiles WHERE user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION get_my_retailer_id()
RETURNS UUID AS $$
  SELECT id FROM retailers WHERE auth_user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ============================================================
-- SECTION 6: EMI SCHEDULE GENERATION
-- ============================================================

CREATE OR REPLACE FUNCTION generate_emi_schedule(p_customer_id UUID)
RETURNS VOID AS $$
DECLARE
  v_customer RECORD;
  v_due_date DATE;
  i          INT;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;

  DELETE FROM emi_schedule WHERE customer_id = p_customer_id;

  FOR i IN 1..v_customer.emi_tenure LOOP
    v_due_date :=
      DATE_TRUNC('month', v_customer.purchase_date + (i || ' months')::INTERVAL)
      + (v_customer.emi_due_day - 1) * INTERVAL '1 day';

    -- Clamp to end of month if emi_due_day > days in that month
    IF v_due_date > (
      DATE_TRUNC('month', v_customer.purchase_date + (i || ' months')::INTERVAL)
      + INTERVAL '1 month - 1 day'
    ) THEN
      v_due_date :=
        DATE_TRUNC('month', v_customer.purchase_date + (i || ' months')::INTERVAL)
        + INTERVAL '1 month - 1 day';
    END IF;

    INSERT INTO emi_schedule (customer_id, emi_no, due_date, amount)
    VALUES (p_customer_id, i, v_due_date, v_customer.emi_amount);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger: auto-generate on INSERT
CREATE OR REPLACE FUNCTION trigger_generate_emi_schedule()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM generate_emi_schedule(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS after_customer_insert ON customers;
CREATE TRIGGER after_customer_insert
  AFTER INSERT ON customers
  FOR EACH ROW
  EXECUTE FUNCTION trigger_generate_emi_schedule();

-- Trigger: re-generate on key field changes
CREATE OR REPLACE FUNCTION trigger_regenerate_emi_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.emi_tenure    != NEW.emi_tenure    OR
     OLD.emi_amount    != NEW.emi_amount    OR
     OLD.purchase_date != NEW.purchase_date OR
     OLD.emi_due_day   != NEW.emi_due_day
  THEN
    PERFORM generate_emi_schedule(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS after_customer_update ON customers;
CREATE TRIGGER after_customer_update
  AFTER UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION trigger_regenerate_emi_on_update();


-- ============================================================
-- SECTION 7: get_due_breakdown (v2 — supports selected EMI)
-- ============================================================

CREATE OR REPLACE FUNCTION get_due_breakdown(
  p_customer_id    UUID,
  p_selected_emi_no INT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_customer             RECORD;
  v_next_emi             RECORD;
  v_selected_emi         RECORD;
  v_fine_setting         RECORD;
  v_fine_due             NUMERIC := 0;
  v_first_emi_charge_due NUMERIC := 0;
  v_emi_amount           NUMERIC := 0;
  v_total_payable        NUMERIC := 0;
  v_popup_first_charge   BOOLEAN := FALSE;
  v_popup_fine           BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RETURN '{"error": "Customer not found"}'::JSONB;
  END IF;

  SELECT * INTO v_fine_setting FROM fine_settings WHERE id = 1;

  -- Lowest unpaid EMI
  SELECT * INTO v_next_emi
  FROM emi_schedule
  WHERE customer_id = p_customer_id AND status = 'UNPAID'
  ORDER BY emi_no ASC LIMIT 1;

  -- Use selected EMI amount if provided
  IF p_selected_emi_no IS NOT NULL THEN
    SELECT * INTO v_selected_emi
    FROM emi_schedule
    WHERE customer_id = p_customer_id
      AND emi_no = p_selected_emi_no
      AND status = 'UNPAID';
    IF FOUND THEN
      v_emi_amount := v_selected_emi.amount;
    END IF;
  ELSE
    v_emi_amount := COALESCE(v_next_emi.amount, 0);
  END IF;

  -- Fine: only on the lowest unpaid EMI when overdue
  IF v_next_emi IS NOT NULL AND CURRENT_DATE > v_next_emi.due_date THEN
    v_fine_due := COALESCE(v_next_emi.fine_amount, 0);
    IF v_fine_due = 0 AND NOT v_next_emi.fine_waived THEN
      v_fine_due := v_fine_setting.default_fine_amount;
    END IF;
    IF v_next_emi.fine_waived THEN v_fine_due := 0; END IF;
    IF v_fine_due > 0 THEN v_popup_fine := TRUE; END IF;
  END IF;

  -- First EMI charge
  IF v_customer.first_emi_charge_amount > 0
     AND v_customer.first_emi_charge_paid_at IS NULL THEN
    v_first_emi_charge_due := v_customer.first_emi_charge_amount;
    v_popup_first_charge   := TRUE;
  END IF;

  v_total_payable := v_emi_amount + v_fine_due + v_first_emi_charge_due;

  RETURN jsonb_build_object(
    'customer_id',          p_customer_id,
    'customer_status',      v_customer.status,
    'next_emi_no',          v_next_emi.emi_no,
    'next_emi_amount',      v_next_emi.amount,
    'next_emi_due_date',    v_next_emi.due_date,
    'next_emi_status',      v_next_emi.status,
    'selected_emi_no',      COALESCE(p_selected_emi_no, v_next_emi.emi_no),
    'selected_emi_amount',  v_emi_amount,
    'fine_due',             v_fine_due,
    'first_emi_charge_due', v_first_emi_charge_due,
    'total_payable',        v_total_payable,
    'popup_first_emi_charge', v_popup_first_charge,
    'popup_fine_due',       v_popup_fine,
    'is_overdue',           (v_next_emi IS NOT NULL AND CURRENT_DATE > v_next_emi.due_date)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- SECTION 8: ATOMIC APPROVAL STORED PROCEDURE
-- Called via supabase.rpc('approve_payment_request', {...})
-- Runs in a single transaction with row-level locking.
-- ============================================================

CREATE OR REPLACE FUNCTION approve_payment_request(
  p_request_id UUID,
  p_admin_id   UUID,
  p_remark     TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_request      RECORD;
  v_item         RECORD;
  v_now          TIMESTAMPTZ := NOW();
  v_emi_ids      UUID[]      := '{}';
  v_unpaid_count INT;
BEGIN
  -- Lock row to prevent double-approval race condition
  SELECT * INTO v_request
  FROM payment_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request not found');
  END IF;

  -- Idempotency: already approved → return success, do nothing
  IF v_request.status = 'APPROVED' THEN
    RETURN jsonb_build_object('success', true, 'already_approved', true);
  END IF;

  IF v_request.status != 'PENDING' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Cannot approve: status is ' || v_request.status
    );
  END IF;

  -- STEP 1: Mark all linked EMIs as APPROVED
  FOR v_item IN
    SELECT pri.emi_schedule_id, pri.emi_no
    FROM payment_request_items pri
    WHERE pri.payment_request_id = p_request_id
  LOOP
    UPDATE emi_schedule
    SET
      status               = 'APPROVED',
      paid_at              = v_now,
      mode                 = v_request.mode,
      approved_by          = p_admin_id,
      collected_by_role    = 'retailer',
      collected_by_user_id = v_request.submitted_by
    WHERE id = v_item.emi_schedule_id;

    v_emi_ids := v_emi_ids || v_item.emi_schedule_id;
  END LOOP;

  -- STEP 2: Record fine PAID (do NOT zero fine_amount — fine must remain visible)
  IF v_request.fine_amount > 0 THEN
    UPDATE emi_schedule
    SET fine_paid_amount = COALESCE(fine_paid_amount, 0) + v_request.fine_amount,
        fine_paid_at = v_now
    WHERE customer_id = v_request.customer_id
      AND emi_no = (
        SELECT MIN(pri.emi_no)
        FROM payment_request_items pri
        WHERE pri.payment_request_id = p_request_id
      );
  END IF;

  -- STEP 3: Mark first EMI charge paid (idempotent)
  IF v_request.first_emi_charge_amount > 0 THEN
    UPDATE customers
    SET first_emi_charge_paid_at = v_now
    WHERE id = v_request.customer_id
      AND first_emi_charge_paid_at IS NULL;
  END IF;

  -- STEP 4: Update payment_request status
  UPDATE payment_requests
  SET
    status      = 'APPROVED',
    approved_by = p_admin_id,
    approved_at = v_now,
    notes       = CASE
                    WHEN p_remark IS NOT NULL
                    THEN COALESCE(notes || E'\n', '') || 'Admin remark: ' || p_remark
                    ELSE notes
                  END
  WHERE id = p_request_id;

  -- STEP 5: Auto-complete customer if all EMIs now paid
  SELECT COUNT(*) INTO v_unpaid_count
  FROM emi_schedule
  WHERE customer_id = v_request.customer_id
    AND status IN ('UNPAID', 'PENDING_APPROVAL');

  IF v_unpaid_count = 0 THEN
    UPDATE customers
    SET status          = 'COMPLETE',
        completion_date = v_now::DATE
    WHERE id     = v_request.customer_id
      AND status = 'RUNNING';
  END IF;

  -- STEP 6: Audit log
  INSERT INTO audit_log (
    actor_user_id, actor_role, action,
    table_name, record_id,
    before_data, after_data, remark
  ) VALUES (
    p_admin_id, 'super_admin', 'APPROVE_PAYMENT',
    'payment_requests', p_request_id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object(
      'status',      'APPROVED',
      'emi_ids',     to_jsonb(v_emi_ids),
      'approved_at', v_now
    ),
    p_remark
  );

  RETURN jsonb_build_object(
    'success',    true,
    'request_id', p_request_id,
    'emi_ids',    to_jsonb(v_emi_ids),
    'approved_at', v_now
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================
-- SECTION 9: SAFETY TRIGGER
-- Even if the API route partially fails, this trigger
-- guarantees EMIs are marked APPROVED whenever
-- payment_requests.status flips to APPROVED.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_auto_apply_payment_on_approval()
RETURNS TRIGGER AS $$
DECLARE
  v_item RECORD;
  v_now  TIMESTAMPTZ := NOW();
BEGIN
  IF OLD.status = 'PENDING' AND NEW.status = 'APPROVED' THEN

    -- Mark all linked EMIs APPROVED (idempotent — COALESCE keeps existing values)
    FOR v_item IN
      SELECT emi_schedule_id
      FROM payment_request_items
      WHERE payment_request_id = NEW.id
    LOOP
      UPDATE emi_schedule
      SET
        status            = 'APPROVED',
        paid_at           = COALESCE(paid_at, v_now),
        mode              = COALESCE(mode, NEW.mode),
        approved_by       = COALESCE(approved_by, NEW.approved_by),
        collected_by_role = COALESCE(collected_by_role, 'retailer')
      WHERE id     = v_item.emi_schedule_id
        AND status != 'APPROVED';  -- skip already-approved rows
    END LOOP;

    -- First EMI charge
    IF NEW.first_emi_charge_amount > 0 THEN
      UPDATE customers
      SET first_emi_charge_paid_at = COALESCE(first_emi_charge_paid_at, v_now)
      WHERE id                       = NEW.customer_id
        AND first_emi_charge_paid_at IS NULL;
    END IF;

    -- Record fine as PAID (do NOT zero — fine must remain for audit)
    IF NEW.fine_amount > 0 THEN
      UPDATE emi_schedule
      SET fine_paid_amount = COALESCE(fine_paid_amount, 0) + NEW.fine_amount,
          fine_paid_at = v_now
      WHERE customer_id = NEW.customer_id
        AND emi_no      = (
          SELECT MIN(pri.emi_no)
          FROM payment_request_items pri
          WHERE pri.payment_request_id = NEW.id
        );
    END IF;

  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_auto_apply_payment_on_approval ON payment_requests;
CREATE TRIGGER trg_auto_apply_payment_on_approval
  AFTER UPDATE OF status ON payment_requests
  FOR EACH ROW
  EXECUTE FUNCTION fn_auto_apply_payment_on_approval();


-- ============================================================
-- SECTION 10: DATA REPAIR
-- Back-fills payment_request_items for any existing PENDING
-- requests that were created by the buggy submit route
-- (which stored emi_id instead of emi_schedule_id).
-- Safe to run even if already run — ON CONFLICT DO NOTHING.
-- ============================================================

INSERT INTO payment_request_items (payment_request_id, emi_schedule_id, emi_no, amount)
SELECT
  pr.id AS payment_request_id,
  es.id AS emi_schedule_id,
  es.emi_no,
  pr.total_emi_amount / GREATEST(array_length(pr.selected_emi_nos, 1), 1) AS amount
FROM payment_requests pr
JOIN LATERAL UNNEST(pr.selected_emi_nos) AS sn(emi_no) ON TRUE
JOIN emi_schedule es
  ON es.customer_id = pr.customer_id
 AND es.emi_no      = sn.emi_no
WHERE pr.selected_emi_nos IS NOT NULL
  AND array_length(pr.selected_emi_nos, 1) > 0
  AND NOT EXISTS (
    SELECT 1 FROM payment_request_items pri
    WHERE pri.payment_request_id = pr.id
  )
ON CONFLICT DO NOTHING;


-- ============================================================
-- SECTION 11: ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE profiles              ENABLE ROW LEVEL SECURITY;
ALTER TABLE retailers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE emi_schedule          ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE fine_settings         ENABLE ROW LEVEL SECURITY;

-- Drop existing policies (idempotent re-run)
DROP POLICY IF EXISTS "profiles_self"               ON profiles;
DROP POLICY IF EXISTS "profiles_admin_all"          ON profiles;
DROP POLICY IF EXISTS "retailers_admin_all"         ON retailers;
DROP POLICY IF EXISTS "retailers_self_read"         ON retailers;
DROP POLICY IF EXISTS "customers_admin_all"         ON customers;
DROP POLICY IF EXISTS "customers_retailer_own"      ON customers;
DROP POLICY IF EXISTS "emi_admin_all"               ON emi_schedule;
DROP POLICY IF EXISTS "emi_retailer_own"            ON emi_schedule;
DROP POLICY IF EXISTS "payment_requests_admin_all"  ON payment_requests;
DROP POLICY IF EXISTS "payment_requests_retailer_own" ON payment_requests;
DROP POLICY IF EXISTS "payment_items_admin"         ON payment_request_items;
DROP POLICY IF EXISTS "payment_items_retailer"      ON payment_request_items;
DROP POLICY IF EXISTS "audit_admin_read"            ON audit_log;
DROP POLICY IF EXISTS "fine_settings_admin"         ON fine_settings;
DROP POLICY IF EXISTS "fine_settings_read"          ON fine_settings;

-- PROFILES
CREATE POLICY "profiles_self"      ON profiles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "profiles_admin_all" ON profiles FOR ALL    USING (get_my_role() = 'super_admin');

-- RETAILERS
CREATE POLICY "retailers_admin_all"  ON retailers FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "retailers_self_read"  ON retailers FOR SELECT USING (auth_user_id = auth.uid());

-- CUSTOMERS
CREATE POLICY "customers_admin_all"    ON customers FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "customers_retailer_own" ON customers FOR SELECT USING (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id()
);

-- EMI SCHEDULE
CREATE POLICY "emi_admin_all"    ON emi_schedule FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "emi_retailer_own" ON emi_schedule FOR SELECT USING (
  get_my_role() = 'retailer' AND
  customer_id IN (SELECT id FROM customers WHERE retailer_id = get_my_retailer_id())
);

-- PAYMENT REQUESTS
CREATE POLICY "payment_requests_admin_all"     ON payment_requests FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "payment_requests_retailer_own"  ON payment_requests FOR SELECT USING (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id()
);

-- PAYMENT REQUEST ITEMS
CREATE POLICY "payment_items_admin"   ON payment_request_items FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "payment_items_retailer" ON payment_request_items FOR SELECT USING (
  get_my_role() = 'retailer' AND
  payment_request_id IN (
    SELECT id FROM payment_requests WHERE retailer_id = get_my_retailer_id()
  )
);

-- AUDIT LOG
CREATE POLICY "audit_admin_read" ON audit_log FOR SELECT USING (get_my_role() = 'super_admin');

-- FINE SETTINGS
CREATE POLICY "fine_settings_admin" ON fine_settings FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "fine_settings_read"  ON fine_settings FOR SELECT USING (auth.uid() IS NOT NULL);


-- ============================================================
-- SECTION 12: GRANTS
-- ============================================================

GRANT EXECUTE ON FUNCTION get_my_role()                              TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_retailer_id()                       TO authenticated;
GRANT EXECUTE ON FUNCTION get_due_breakdown(UUID, INT)               TO authenticated;
GRANT EXECUTE ON FUNCTION approve_payment_request(UUID, UUID, TEXT)  TO service_role;


-- ============================================================
-- SECTION 13: SEED SUPER ADMIN
-- Change the email to match your actual admin user email.
-- ============================================================

INSERT INTO profiles (user_id, role)
SELECT id, 'super_admin'
FROM auth.users
WHERE email = 'telepoint@admin.local'
ON CONFLICT (user_id) DO UPDATE SET role = 'super_admin';


-- ============================================================
-- DONE
-- ============================================================

DO $$
BEGIN
  RAISE NOTICE '================================================';
  RAISE NOTICE 'EMI Portal SQL completed successfully.';
  RAISE NOTICE 'Tables:    profiles, retailers, customers,';
  RAISE NOTICE '           emi_schedule, payment_requests,';
  RAISE NOTICE '           payment_request_items, audit_log,';
  RAISE NOTICE '           fine_settings';
  RAISE NOTICE 'Functions: get_due_breakdown, get_my_role,';
  RAISE NOTICE '           get_my_retailer_id,';
  RAISE NOTICE '           approve_payment_request (atomic RPC)';
  RAISE NOTICE 'Triggers:  after_customer_insert (EMI gen),';
  RAISE NOTICE '           after_customer_update (EMI regen),';
  RAISE NOTICE '           trg_auto_apply_payment_on_approval';
  RAISE NOTICE '================================================';
END $$;
