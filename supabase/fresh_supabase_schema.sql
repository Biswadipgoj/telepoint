-- ============================================================
-- EMI PORTAL — FRESH SUPABASE SCHEMA
-- Use this file on a BRAND NEW Supabase project.
-- Run in: Supabase → SQL Editor → New query → Run
-- ============================================================

-- ============================================================
-- SECTION 1: EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- SECTION 2: TABLES
-- ============================================================

-- PROFILES (one per auth.users row — stores role)
CREATE TABLE IF NOT EXISTS profiles (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('super_admin', 'retailer')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RETAILERS
CREATE TABLE IF NOT EXISTS retailers (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  username     TEXT UNIQUE NOT NULL,
  retail_pin   TEXT,
  mobile       TEXT,
  is_active    BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  retailer_id              UUID NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  customer_name            TEXT NOT NULL,
  father_name              TEXT,
  aadhaar                  TEXT CHECK (aadhaar IS NULL OR LENGTH(aadhaar) = 12),
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
  emi_start_date           DATE,
  emi_due_day              INT CHECK (emi_due_day BETWEEN 1 AND 28),
  emi_amount               NUMERIC(12,2) NOT NULL,
  emi_tenure               INT NOT NULL CHECK (emi_tenure BETWEEN 1 AND 12),
  first_emi_charge_amount  NUMERIC(12,2) DEFAULT 0,
  first_emi_charge_paid_at TIMESTAMPTZ,
  box_no                   TEXT,
  -- Image URLs (IBB hosted)
  customer_photo_url       TEXT,
  aadhaar_front_url        TEXT,
  aadhaar_back_url         TEXT,
  bill_photo_url           TEXT,
  emi_card_photo_url       TEXT,
  -- Legacy image columns (kept for backwards compat)
  photo_url                TEXT,
  bill_url                 TEXT,
  card_url                 TEXT,
  -- Phone lock
  is_locked                BOOLEAN DEFAULT FALSE,
  lock_provider            TEXT,
  lock_device_id           TEXT,
  -- Misc
  google_drive_docs        TEXT,
  -- Status: RUNNING → COMPLETE (auto) | SETTLED (manual) | NPA (bad debt)
  status                   TEXT NOT NULL DEFAULT 'RUNNING'
                             CHECK (status IN ('RUNNING', 'COMPLETE', 'SETTLED', 'NPA')),
  completion_remark        TEXT,
  completion_date          DATE,
  settlement_amount        NUMERIC(12,2),
  settlement_date          DATE,
  settled_by               UUID REFERENCES auth.users(id),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

-- EMI SCHEDULE
CREATE TABLE IF NOT EXISTS emi_schedule (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id          UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  emi_no               INT NOT NULL,
  due_date             DATE NOT NULL,
  amount               NUMERIC(12,2) NOT NULL,
  -- APPROVED = fully paid; PARTIALLY_PAID = partially paid; PENDING_APPROVAL = submitted by retailer
  status               TEXT NOT NULL DEFAULT 'UNPAID'
                         CHECK (status IN ('UNPAID', 'PENDING_APPROVAL', 'PARTIALLY_PAID', 'APPROVED')),
  partial_paid_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  partial_paid_at      TIMESTAMPTZ,
  paid_at              TIMESTAMPTZ,
  mode                 TEXT CHECK (mode IN ('CASH', 'UPI')),
  utr                  TEXT,
  approved_by          UUID REFERENCES auth.users(id),
  fine_amount          NUMERIC(12,2) DEFAULT 0,
  fine_waived          BOOLEAN DEFAULT FALSE,
  fine_paid_amount     NUMERIC(12,2) DEFAULT 0,
  fine_paid_at         TIMESTAMPTZ,
  fine_last_calculated_at TIMESTAMPTZ,
  collected_by_role    TEXT CHECK (collected_by_role IN ('admin', 'retailer')),
  collected_by_user_id UUID REFERENCES auth.users(id),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, emi_no)
);

-- PAYMENT REQUESTS (one per collection event from retailer)
CREATE TABLE IF NOT EXISTS payment_requests (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id             UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  retailer_id             UUID NOT NULL REFERENCES retailers(id),
  submitted_by            UUID REFERENCES auth.users(id),
  status                  TEXT NOT NULL DEFAULT 'PENDING'
                            CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  mode                    TEXT NOT NULL CHECK (mode IN ('CASH', 'UPI')),
  utr                     TEXT,
  total_emi_amount        NUMERIC(12,2) DEFAULT 0,
  scheduled_emi_amount    NUMERIC(12,2) DEFAULT 0,
  fine_amount             NUMERIC(12,2) DEFAULT 0,
  first_emi_charge_amount NUMERIC(12,2) DEFAULT 0,
  total_amount            NUMERIC(12,2) NOT NULL,
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

-- PAYMENT REQUEST ITEMS (links request ↔ emi rows)
CREATE TABLE IF NOT EXISTS payment_request_items (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_request_id UUID NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  emi_schedule_id    UUID NOT NULL REFERENCES emi_schedule(id),
  emi_no             INT NOT NULL,
  amount             NUMERIC(12,2) NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- AUDIT LOG
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

-- FINE SETTINGS (singleton row, id=1)
CREATE TABLE IF NOT EXISTS fine_settings (
  id                    INT PRIMARY KEY DEFAULT 1,
  default_fine_amount   NUMERIC(12,2) DEFAULT 450,
  weekly_fine_increment NUMERIC(12,2) DEFAULT 25,
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_by            UUID REFERENCES auth.users(id),
  CHECK (id = 1)
);
INSERT INTO fine_settings (id, default_fine_amount, weekly_fine_increment)
VALUES (1, 450, 25)
ON CONFLICT DO NOTHING;

-- BROADCAST MESSAGES (admin → retailer notifications)
CREATE TABLE IF NOT EXISTS broadcast_messages (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_retailer_id UUID REFERENCES retailers(id) ON DELETE CASCADE,
  message           TEXT NOT NULL,
  image_url         TEXT,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_by        UUID REFERENCES auth.users(id),
  sender_name       TEXT DEFAULT 'TELEPOINT',
  sender_role       TEXT DEFAULT 'admin',
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- CUSTOMER APP TOKENS (persistent QR-based customer login)
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

-- FINE HISTORY (audit trail for fine changes)
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
-- SECTION 3: INDEXES
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
-- SECTION 4: HELPER FUNCTIONS (security definer)
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

-- ============================================================
-- SECTION 5: EMI AUTO-GENERATION TRIGGER
-- Generates emi_schedule rows when a customer is created/updated
-- ============================================================

CREATE OR REPLACE FUNCTION fn_generate_emi_schedule()
RETURNS TRIGGER AS $$
DECLARE
  v_start_date DATE;
  v_due_day    INT;
  v_i          INT;
  v_due_date   DATE;
BEGIN
  -- Calculate start date from emi_start_date or purchase_date
  v_start_date := COALESCE(NEW.emi_start_date, NEW.purchase_date);
  v_due_day    := COALESCE(NEW.emi_due_day, EXTRACT(DAY FROM v_start_date)::INT);

  -- Only regenerate on INSERT or tenure/amount change
  IF TG_OP = 'UPDATE' THEN
    IF OLD.emi_amount = NEW.emi_amount AND OLD.emi_tenure = NEW.emi_tenure
       AND OLD.emi_due_day IS NOT DISTINCT FROM NEW.emi_due_day
       AND OLD.emi_start_date IS NOT DISTINCT FROM NEW.emi_start_date THEN
      RETURN NEW;
    END IF;
    -- Delete only UNPAID EMIs on update (preserve paid ones)
    DELETE FROM emi_schedule
    WHERE customer_id = NEW.id AND status = 'UNPAID';
  END IF;

  FOR v_i IN 1..NEW.emi_tenure LOOP
    -- Calculate due date: first EMI = start_date + 1 month adjusted to due_day
    v_due_date := (v_start_date + (v_i || ' months')::INTERVAL)::DATE;
    -- Adjust to emi_due_day within same month
    v_due_date := DATE_TRUNC('month', v_due_date)::DATE + (v_due_day - 1);

    -- Only insert if this EMI doesn't already exist
    INSERT INTO emi_schedule (customer_id, emi_no, due_date, amount)
    VALUES (NEW.id, v_i, v_due_date, NEW.emi_amount)
    ON CONFLICT (customer_id, emi_no) DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS after_customer_insert ON customers;
CREATE TRIGGER after_customer_insert
  AFTER INSERT ON customers
  FOR EACH ROW EXECUTE FUNCTION fn_generate_emi_schedule();

DROP TRIGGER IF EXISTS after_customer_update ON customers;
CREATE TRIGGER after_customer_update
  AFTER UPDATE OF emi_amount, emi_tenure, emi_due_day, emi_start_date ON customers
  FOR EACH ROW EXECUTE FUNCTION fn_generate_emi_schedule();

-- ============================================================
-- SECTION 6: get_due_breakdown — returns what's owed today
-- ============================================================

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
  v_total            NUMERIC := 0;
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

  -- Get fine settings
  SELECT COALESCE(default_fine_amount, 450), COALESCE(weekly_fine_increment, 25)
  INTO v_base_fine, v_weekly
  FROM fine_settings WHERE id = 1;

  -- Get next unpaid EMI
  SELECT * INTO v_next_emi
  FROM emi_schedule
  WHERE customer_id = p_customer_id
    AND status IN ('UNPAID', 'PARTIALLY_PAID')
  ORDER BY emi_no ASC LIMIT 1;

  -- If selected_emi_no provided, use that
  IF p_selected_emi_no IS NOT NULL THEN
    SELECT * INTO v_selected_emi
    FROM emi_schedule
    WHERE customer_id = p_customer_id AND emi_no = p_selected_emi_no AND status = 'UNPAID';
    IF FOUND THEN v_emi_amount := v_selected_emi.amount; END IF;
  ELSE
    v_emi_amount := COALESCE(v_next_emi.amount, 0)
      - COALESCE(v_next_emi.partial_paid_amount, 0);
    v_emi_amount := GREATEST(0, v_emi_amount);
  END IF;

  -- Max emi_no for last-EMI detection
  SELECT MAX(emi_no) INTO v_max_emi_no FROM emi_schedule WHERE customer_id = p_customer_id;

  -- Calculate total fine across all overdue EMIs
  FOR v_fine_row IN
    SELECT * FROM emi_schedule
    WHERE customer_id = p_customer_id
      AND status IN ('UNPAID', 'PARTIALLY_PAID')
      AND due_date < CURRENT_DATE
      AND fine_waived = FALSE
  LOOP
    v_days := GREATEST(0, (CURRENT_DATE - v_fine_row.due_date)::INT);
    IF v_fine_row.emi_no = v_max_emi_no THEN
      -- Last EMI: ₹450 repeats every 30 days, no weekly
      v_calc_fine := CEIL(v_days::NUMERIC / 30) * v_base_fine;
    ELSIF v_days <= 30 THEN
      v_calc_fine := v_base_fine;
    ELSE
      v_weeks := FLOOR((v_days - 30)::NUMERIC / 7);
      v_calc_fine := v_base_fine + (v_weeks * v_weekly);
    END IF;
    -- Use max of calculated vs stored fine
    v_calc_fine := GREATEST(v_calc_fine, COALESCE(v_fine_row.fine_amount, 0));
    -- Subtract already-paid fine
    v_fine_due := v_fine_due + GREATEST(0, v_calc_fine - COALESCE(v_fine_row.fine_paid_amount, 0));

    IF v_fine_row.due_date < CURRENT_DATE THEN v_is_overdue := TRUE; END IF;
  END LOOP;

  -- First EMI charge
  IF COALESCE(v_customer.first_emi_charge_amount, 0) > 0
     AND v_customer.first_emi_charge_paid_at IS NULL THEN
    v_first_charge_due := v_customer.first_emi_charge_amount;
  END IF;

  v_total := v_emi_amount + v_fine_due + v_first_charge_due;

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
    'total_payable',        v_total,
    'popup_first_emi_charge', v_first_charge_due > 0,
    'popup_fine_due',         v_fine_due > 0,
    'is_overdue',             v_is_overdue
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================
-- SECTION 7: approve_payment_request — ATOMIC RPC
-- Called by admin to approve a payment in a single transaction
-- ============================================================

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
  -- Fetch + lock request row
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

  -- STEP 1: Mark all linked EMIs APPROVED with partial tracking
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

  -- STEP 2: Record fine paid (do NOT zero fine_amount — keep it for audit)
  IF COALESCE(v_request.fine_amount, 0) > 0 THEN
    UPDATE emi_schedule
    SET
      fine_paid_amount = LEAST(
        fine_amount,
        COALESCE(fine_paid_amount, 0) + v_request.fine_amount
      ),
      fine_paid_at = COALESCE(fine_paid_at, v_now),
      updated_at   = v_now
    WHERE customer_id = v_request.customer_id
      AND emi_no = COALESCE(
        v_request.fine_for_emi_no,
        (SELECT MIN(pri.emi_no) FROM payment_request_items pri WHERE pri.payment_request_id = p_request_id)
      );
  END IF;

  -- STEP 3: Mark first EMI charge paid (idempotent)
  IF COALESCE(v_request.first_emi_charge_amount, 0) > 0 THEN
    UPDATE customers
    SET first_emi_charge_paid_at = COALESCE(first_emi_charge_paid_at, v_now),
        updated_at = v_now
    WHERE id = v_request.customer_id;
  END IF;

  -- STEP 4: Approve the payment_request row
  UPDATE payment_requests
  SET
    status      = 'APPROVED',
    approved_by = p_admin_id,
    approved_at = v_now,
    updated_at  = v_now,
    notes       = CASE
                    WHEN p_remark IS NOT NULL
                    THEN COALESCE(notes || E'\n', '') || 'Admin remark: ' || p_remark
                    ELSE notes
                  END
  WHERE id = p_request_id;

  -- STEP 5: Auto-complete customer if all EMIs paid
  SELECT COUNT(*) INTO v_unpaid_count
  FROM emi_schedule
  WHERE customer_id = v_request.customer_id
    AND status IN ('UNPAID', 'PENDING_APPROVAL', 'PARTIALLY_PAID');

  -- Also check fine and first charge
  DECLARE
    v_fine_pending    BOOLEAN;
    v_charge_pending  BOOLEAN;
    v_cust            RECORD;
  BEGIN
    SELECT * INTO v_cust FROM customers WHERE id = v_request.customer_id;
    v_fine_pending := EXISTS (
      SELECT 1 FROM emi_schedule
      WHERE customer_id = v_request.customer_id
        AND fine_waived = FALSE
        AND fine_amount > COALESCE(fine_paid_amount, 0)
    );
    v_charge_pending := COALESCE(v_cust.first_emi_charge_amount, 0) > 0
                     AND v_cust.first_emi_charge_paid_at IS NULL;

    IF v_unpaid_count = 0 AND NOT v_fine_pending AND NOT v_charge_pending THEN
      UPDATE customers
      SET status = 'COMPLETE', completion_date = v_now::DATE, updated_at = v_now
      WHERE id = v_request.customer_id AND status = 'RUNNING';
    END IF;
  END;

  -- STEP 6: Audit log
  INSERT INTO audit_log (
    actor_user_id, actor_role, action,
    table_name, record_id,
    before_data, after_data, remark
  ) VALUES (
    p_admin_id, 'super_admin', 'APPROVE_PAYMENT',
    'payment_requests', p_request_id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object('status', 'APPROVED', 'emi_ids', to_jsonb(v_emi_ids), 'approved_at', v_now),
    p_remark
  );

  RETURN jsonb_build_object(
    'success',      true,
    'request_id',   p_request_id,
    'emi_ids',      to_jsonb(v_emi_ids),
    'approved_at',  v_now
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- SECTION 8: updated_at auto-update trigger
-- ============================================================

CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['customers', 'retailers', 'emi_schedule', 'payment_requests', 'customer_app_tokens'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON %I', tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at()',
      tbl
    );
  END LOOP;
END;
$$;

-- ============================================================
-- SECTION 9: ROW LEVEL SECURITY
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

-- Drop existing policies (idempotent)
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, pol.tablename);
  END LOOP;
END;
$$;

-- PROFILES
CREATE POLICY "profiles_self"      ON profiles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "profiles_admin_all" ON profiles FOR ALL    USING (get_my_role() = 'super_admin');

-- RETAILERS
CREATE POLICY "retailers_admin_all"  ON retailers FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "retailers_self_read"  ON retailers FOR SELECT USING (auth_user_id = auth.uid());

-- CUSTOMERS
CREATE POLICY "customers_admin_all"    ON customers FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "customers_retailer_own" ON customers FOR SELECT USING (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id()
);
CREATE POLICY "customers_retailer_ins" ON customers FOR INSERT WITH CHECK (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id()
);
CREATE POLICY "customers_retailer_upd" ON customers FOR UPDATE USING (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id()
);

-- EMI SCHEDULE
CREATE POLICY "emi_admin_all"    ON emi_schedule FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "emi_retailer_own" ON emi_schedule FOR SELECT USING (
  get_my_role() = 'retailer' AND
  customer_id IN (SELECT id FROM customers WHERE retailer_id = get_my_retailer_id())
);

-- PAYMENT REQUESTS
CREATE POLICY "payment_requests_admin_all"    ON payment_requests FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "payment_requests_retailer_own" ON payment_requests FOR SELECT USING (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id()
);
CREATE POLICY "payment_requests_retailer_ins" ON payment_requests FOR INSERT WITH CHECK (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id()
);

-- PAYMENT REQUEST ITEMS
CREATE POLICY "payment_items_admin"   ON payment_request_items FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "payment_items_retailer" ON payment_request_items FOR SELECT USING (
  get_my_role() = 'retailer' AND
  payment_request_id IN (SELECT id FROM payment_requests WHERE retailer_id = get_my_retailer_id())
);
CREATE POLICY "payment_items_ins" ON payment_request_items FOR INSERT WITH CHECK (
  get_my_role() IN ('super_admin', 'retailer')
);

-- AUDIT LOG
CREATE POLICY "audit_admin_read" ON audit_log FOR SELECT USING (get_my_role() = 'super_admin');
CREATE POLICY "audit_service_ins" ON audit_log FOR INSERT WITH CHECK (TRUE);

-- FINE SETTINGS
CREATE POLICY "fine_settings_admin" ON fine_settings FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "fine_settings_read"  ON fine_settings FOR SELECT USING (auth.uid() IS NOT NULL);

-- BROADCAST MESSAGES
CREATE POLICY "broadcast_admin_all"     ON broadcast_messages FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "broadcast_retailer_read" ON broadcast_messages FOR SELECT USING (
  get_my_role() = 'retailer' AND
  (target_retailer_id = get_my_retailer_id() OR target_retailer_id IS NULL)
);

-- CUSTOMER APP TOKENS (service-role only; no direct client access)
CREATE POLICY "cat_admin_all" ON customer_app_tokens FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "cat_retailer_read" ON customer_app_tokens FOR SELECT USING (
  get_my_role() = 'retailer' AND
  customer_id IN (SELECT id FROM customers WHERE retailer_id = get_my_retailer_id())
);

-- FINE HISTORY
CREATE POLICY "fine_history_admin" ON fine_history FOR ALL    USING (get_my_role() = 'super_admin');
CREATE POLICY "fine_history_read"  ON fine_history FOR SELECT USING (
  get_my_role() = 'retailer' AND
  customer_id IN (SELECT id FROM customers WHERE retailer_id = get_my_retailer_id())
);

-- ============================================================
-- SECTION 10: GRANTS
-- ============================================================

GRANT EXECUTE ON FUNCTION get_my_role()                              TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_retailer_id()                       TO authenticated;
GRANT EXECUTE ON FUNCTION get_due_breakdown(UUID, INT)               TO authenticated;
GRANT EXECUTE ON FUNCTION approve_payment_request(UUID, UUID, TEXT)  TO service_role;

-- ============================================================
-- SECTION 11: SEED SUPER ADMIN
-- Change email to match your admin account in Supabase Auth
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
  RAISE NOTICE 'EMI Portal FRESH SCHEMA complete.';
  RAISE NOTICE 'Tables: profiles, retailers, customers,';
  RAISE NOTICE '        emi_schedule, payment_requests,';
  RAISE NOTICE '        payment_request_items, audit_log,';
  RAISE NOTICE '        fine_settings, broadcast_messages,';
  RAISE NOTICE '        customer_app_tokens, fine_history';
  RAISE NOTICE 'Functions: get_my_role, get_my_retailer_id,';
  RAISE NOTICE '           get_due_breakdown,';
  RAISE NOTICE '           approve_payment_request (atomic)';
  RAISE NOTICE 'Triggers: after_customer_insert/update (EMI gen),';
  RAISE NOTICE '          trg_updated_at on all main tables';
  RAISE NOTICE '================================================';
END $$;
