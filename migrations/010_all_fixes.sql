-- ============================================================
-- MIGRATION 010: Fine engine + lock + broadcast + auto-complete
-- Run in Supabase SQL Editor
-- ============================================================

-- ── 1. New columns ──────────────────────────────────────────
ALTER TABLE fine_settings ADD COLUMN IF NOT EXISTS weekly_fine_increment NUMERIC(12,2) DEFAULT 25;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS fine_last_calculated_at TIMESTAMPTZ;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS fine_paid_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS fine_paid_at TIMESTAMPTZ;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS utr TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS emi_start_date DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS emi_card_photo_url TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS settlement_amount NUMERIC(12,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS settlement_date DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_locked BOOLEAN DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lock_provider TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS lock_device_id TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_drive_docs TEXT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS utr TEXT;
ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS sender_name TEXT DEFAULT 'TELEPOINT';
ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS sender_role TEXT DEFAULT 'admin';

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_status_check CHECK (status IN ('RUNNING','COMPLETE','SETTLED','NPA'));

-- ── 2. Fine History table ───────────────────────────────────
CREATE TABLE IF NOT EXISTS fine_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  emi_schedule_id UUID REFERENCES emi_schedule(id) ON DELETE CASCADE,
  emi_no INT,
  fine_type TEXT NOT NULL CHECK (fine_type IN ('BASE','WEEKLY','PAID','WAIVED')),
  fine_amount NUMERIC(12,2) NOT NULL,
  cumulative_fine NUMERIC(12,2) NOT NULL DEFAULT 0,
  fine_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fine_history_cust ON fine_history(customer_id);
CREATE INDEX IF NOT EXISTS idx_fine_history_emi ON fine_history(emi_schedule_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_utr ON payment_requests(utr);

ALTER TABLE fine_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fh_admin" ON fine_history;
DROP POLICY IF EXISTS "fh_retailer" ON fine_history;
DROP POLICY IF EXISTS "fh_insert" ON fine_history;
CREATE POLICY "fh_admin" ON fine_history FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "fh_retailer" ON fine_history FOR SELECT USING (get_my_role() = 'retailer' AND customer_id IN (SELECT id FROM customers WHERE retailer_id = get_my_retailer_id()));
CREATE POLICY "fh_insert" ON fine_history FOR INSERT WITH CHECK (TRUE);


-- ── 2b. Customer App Tokens (for auto-login app) ────────────
CREATE TABLE IF NOT EXISTS customer_app_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES auth.users(id),
  last_accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_app_tokens_customer ON customer_app_tokens(customer_id);
CREATE INDEX IF NOT EXISTS idx_app_tokens_token ON customer_app_tokens(token);

ALTER TABLE customer_app_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_tokens_admin" ON customer_app_tokens;
DROP POLICY IF EXISTS "app_tokens_retailer" ON customer_app_tokens;
DROP POLICY IF EXISTS "app_tokens_anon_read" ON customer_app_tokens;
CREATE POLICY "app_tokens_admin" ON customer_app_tokens FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "app_tokens_retailer" ON customer_app_tokens FOR ALL USING (
  get_my_role() = 'retailer' AND
  customer_id IN (SELECT id FROM customers WHERE retailer_id = get_my_retailer_id())
);
-- Service role handles token validation (no user auth needed for customer access)
GRANT SELECT ON customer_app_tokens TO anon;
GRANT SELECT, INSERT, UPDATE ON customer_app_tokens TO authenticated;
GRANT ALL ON customer_app_tokens TO service_role;

-- ── 3. FIX: Remove ALL fine zeroing from approve RPC ────────
-- The old code did: SET fine_amount = 0, fine_waived = TRUE
-- New code: SET fine_paid_amount = fine_amount, fine_paid_at = NOW()
-- These CREATE OR REPLACE overwrite the broken functions

-- Fix approve_payment_request (if it exists as RPC)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'approve_payment_request') THEN
    EXECUTE $fn$
    CREATE OR REPLACE FUNCTION approve_payment_request(p_request_id UUID, p_admin_id UUID)
    RETURNS VOID AS $body$
    DECLARE v_request RECORD; v_item RECORD; v_now TIMESTAMPTZ := NOW(); v_emi_ids UUID[] := '{}';
    BEGIN
      SELECT * INTO v_request FROM payment_requests WHERE id = p_request_id AND status = 'PENDING';
      IF NOT FOUND THEN RAISE EXCEPTION 'Request not found or not pending'; END IF;
      UPDATE payment_requests SET status = 'APPROVED', approved_by = p_admin_id, approved_at = v_now WHERE id = p_request_id;
      FOR v_item IN SELECT * FROM payment_request_items WHERE payment_request_id = p_request_id LOOP
        UPDATE emi_schedule SET status = 'APPROVED', paid_at = v_now, mode = v_request.mode,
          approved_by = p_admin_id, collected_by_role = 'retailer', collected_by_user_id = v_request.submitted_by
        WHERE id = v_item.emi_schedule_id;
        v_emi_ids := v_emi_ids || v_item.emi_schedule_id;
      END LOOP;
      -- FIXED: Record fine as PAID, do NOT zero fine_amount
      IF v_request.fine_amount > 0 THEN
        UPDATE emi_schedule SET fine_paid_amount = COALESCE(fine_paid_amount,0) + v_request.fine_amount, fine_paid_at = v_now
        WHERE customer_id = v_request.customer_id AND emi_no = (SELECT MIN(emi_no) FROM payment_request_items WHERE payment_request_id = p_request_id);
        INSERT INTO fine_history (customer_id, emi_no, fine_type, fine_amount, cumulative_fine, fine_date, reason)
        VALUES (v_request.customer_id, (SELECT MIN(emi_no) FROM payment_request_items WHERE payment_request_id = p_request_id),
          'PAID', v_request.fine_amount, v_request.fine_amount, CURRENT_DATE, 'Collected via approval');
      END IF;
      IF v_request.first_emi_charge_amount > 0 THEN
        UPDATE customers SET first_emi_charge_paid_at = v_now WHERE id = v_request.customer_id AND first_emi_charge_paid_at IS NULL;
      END IF;
    END;
    $body$ LANGUAGE plpgsql SECURITY DEFINER;
    $fn$;
  END IF;
END $$;

-- Fix the auto-apply trigger
CREATE OR REPLACE FUNCTION fn_auto_apply_payment_on_approval()
RETURNS TRIGGER AS $$
DECLARE v_item RECORD; v_now TIMESTAMPTZ := NOW();
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = 'APPROVED' AND OLD.status != 'APPROVED' THEN
    FOR v_item IN SELECT * FROM payment_request_items WHERE payment_request_id = NEW.id LOOP
      UPDATE emi_schedule SET status = 'APPROVED', paid_at = v_now, mode = NEW.mode,
        utr = NEW.utr, approved_by = NEW.approved_by, collected_by_role = COALESCE(NEW.collected_by_role, 'retailer'),
        collected_by_user_id = NEW.submitted_by
      WHERE id = v_item.emi_schedule_id AND status != 'APPROVED';
    END LOOP;
    IF NEW.first_emi_charge_amount > 0 THEN
      UPDATE customers SET first_emi_charge_paid_at = COALESCE(first_emi_charge_paid_at, v_now) WHERE id = NEW.customer_id AND first_emi_charge_paid_at IS NULL;
    END IF;
    -- FIXED: Record fine as PAID, NOT zeroed
    IF NEW.fine_amount > 0 THEN
      UPDATE emi_schedule SET fine_paid_amount = COALESCE(fine_paid_amount,0) + NEW.fine_amount, fine_paid_at = v_now
      WHERE customer_id = NEW.customer_id AND emi_no = (SELECT MIN(emi_no) FROM payment_request_items WHERE payment_request_id = NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_auto_apply ON payment_requests;
CREATE TRIGGER trg_auto_apply AFTER UPDATE ON payment_requests FOR EACH ROW EXECUTE FUNCTION fn_auto_apply_payment_on_approval();

-- ── 4. FINE ENGINE ──────────────────────────────────────────
-- Rules: 450 base, 30-day grace (no weekly), then 25/week
-- Last EMI: 450 repeats every 30 days
-- Fine persists even if EMI paid
CREATE OR REPLACE FUNCTION calculate_and_apply_fines()
RETURNS TABLE(updated_count INT) AS $$
DECLARE
  v_base NUMERIC; v_weekly NUMERIC; v_count INT := 0;
  v_emi RECORD; v_days INT; v_weeks INT; v_calc NUMERIC; v_old NUMERIC;
  v_is_last BOOLEAN; v_blocks INT;
BEGIN
  SELECT default_fine_amount, COALESCE(weekly_fine_increment, 25)
  INTO v_base, v_weekly FROM fine_settings WHERE id = 1;
  IF v_base IS NULL THEN v_base := 450; END IF;
  IF v_weekly IS NULL THEN v_weekly := 25; END IF;

  -- Loop ALL overdue EMIs + EMIs with unpaid fines (even if EMI itself is paid)
  FOR v_emi IN
    SELECT es.id, es.customer_id, es.emi_no, es.due_date, es.status,
           es.fine_amount, es.fine_waived, es.fine_paid_amount, c.emi_tenure
    FROM emi_schedule es
    JOIN customers c ON c.id = es.customer_id
    WHERE es.due_date < CURRENT_DATE
      AND es.fine_waived = FALSE
      AND c.status = 'RUNNING'
      AND (
        es.status = 'UNPAID'
        OR (COALESCE(es.fine_paid_amount, 0) < COALESCE(es.fine_amount, 0))
      )
  LOOP
    v_days := CURRENT_DATE - v_emi.due_date;
    IF v_days <= 0 THEN CONTINUE; END IF;

    -- CRITICAL: isLastEmi based on emi_no = tenure, NOT on payment status
    -- Even if last EMI is paid, if fine unpaid → still last EMI rules
    v_is_last := (v_emi.emi_no = v_emi.emi_tenure);

    IF v_is_last THEN
      -- LAST EMI: ₹450 repeats every 30 days. ZERO weekly. Ever.
      v_blocks := CEIL(v_days::NUMERIC / 30);
      v_calc := v_blocks * v_base;
    ELSE
      -- Normal EMI: ₹450 base, 30-day grace, then ₹25/week
      IF v_days <= 30 THEN
        v_calc := v_base;
      ELSE
        v_weeks := (v_days - 30) / 7;
        v_calc := v_base + (v_weeks * v_weekly);
      END IF;
    END IF;

    v_old := COALESCE(v_emi.fine_amount, 0);

    IF v_calc != v_old THEN
      UPDATE emi_schedule
      SET fine_amount = v_calc,
          fine_last_calculated_at = NOW(),
          updated_at = NOW()
      WHERE id = v_emi.id;

      -- Audit trail
      INSERT INTO fine_history (customer_id, emi_schedule_id, emi_no,
        fine_type, fine_amount, cumulative_fine, fine_date, reason)
      VALUES (
        v_emi.customer_id, v_emi.id, v_emi.emi_no,
        CASE WHEN v_old = 0 THEN 'BASE' ELSE 'WEEKLY' END,
        v_calc - v_old, v_calc, CURRENT_DATE,
        v_days || 'd overdue'
          || CASE WHEN v_is_last THEN ' (LAST EMI, no weekly)'
             ELSE '' END
          || '. Fine: ' || v_old || ' → ' || v_calc
      );

      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION calculate_and_apply_fines() TO authenticated;
GRANT EXECUTE ON FUNCTION calculate_and_apply_fines() TO service_role;

-- ── 5. EMI generator with emi_start_date ────────────────────
CREATE OR REPLACE FUNCTION generate_emi_schedule(p_customer_id UUID)
RETURNS VOID AS $$
DECLARE v RECORD; base_month DATE; dd DATE; i INT;
BEGIN
  SELECT * INTO v FROM customers WHERE id = p_customer_id;
  DELETE FROM emi_schedule WHERE customer_id = p_customer_id;

  -- emi_start_date = first day of month where first EMI falls
  -- If not set, default = month after purchase_date
  IF v.emi_start_date IS NOT NULL THEN
    base_month := DATE_TRUNC('month', v.emi_start_date);
  ELSE
    base_month := DATE_TRUNC('month', v.purchase_date) + INTERVAL '1 month';
  END IF;

  FOR i IN 0..(v.emi_tenure - 1) LOOP
    dd := base_month + (i || ' months')::INTERVAL + ((v.emi_due_day - 1) || ' days')::INTERVAL;
    -- Clamp to end of month if due_day > days in month
    IF EXTRACT(DAY FROM dd) != v.emi_due_day THEN
      dd := (DATE_TRUNC('month', base_month + (i || ' months')::INTERVAL) + INTERVAL '1 month' - INTERVAL '1 day');
    END IF;
    INSERT INTO emi_schedule (customer_id, emi_no, due_date, amount) VALUES (p_customer_id, i + 1, dd, v.emi_amount);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 6. Fix trigger to detect emi_start_date changes ─────────
CREATE OR REPLACE FUNCTION trigger_regenerate_emi_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.emi_tenure    != NEW.emi_tenure    OR
     OLD.emi_amount    != NEW.emi_amount    OR
     OLD.purchase_date != NEW.purchase_date OR
     OLD.emi_due_day   != NEW.emi_due_day   OR
     COALESCE(OLD.emi_start_date::TEXT, '') != COALESCE(NEW.emi_start_date::TEXT, '')
  THEN
    PERFORM generate_emi_schedule(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS after_customer_update ON customers;
CREATE TRIGGER after_customer_update AFTER UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION trigger_regenerate_emi_on_update();

-- ── 7. Auto-complete trigger ────────────────────────────────
CREATE OR REPLACE FUNCTION fn_check_auto_complete()
RETURNS TRIGGER AS $$
DECLARE v_unpaid INT; v_fine_unpaid INT; v_cust RECORD;
BEGIN
  SELECT * INTO v_cust FROM customers WHERE id = NEW.customer_id AND status = 'RUNNING';
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT COUNT(*) INTO v_unpaid FROM emi_schedule WHERE customer_id = NEW.customer_id AND status IN ('UNPAID','PENDING_APPROVAL');
  SELECT COUNT(*) INTO v_fine_unpaid FROM emi_schedule WHERE customer_id = NEW.customer_id AND fine_amount > 0 AND COALESCE(fine_paid_amount,0) < fine_amount AND fine_waived = FALSE;
  IF v_unpaid = 0 AND v_fine_unpaid = 0 AND (v_cust.first_emi_charge_amount = 0 OR v_cust.first_emi_charge_paid_at IS NOT NULL) THEN
    UPDATE customers SET status = 'COMPLETE', completion_date = CURRENT_DATE WHERE id = NEW.customer_id AND status = 'RUNNING';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_auto_complete ON emi_schedule;
CREATE TRIGGER trg_auto_complete AFTER UPDATE ON emi_schedule FOR EACH ROW EXECUTE FUNCTION fn_check_auto_complete();

-- ── 8. Broadcast RLS for retailers ──────────────────────────
DROP POLICY IF EXISTS "broadcast_retailer_insert" ON broadcast_messages;
CREATE POLICY "broadcast_retailer_insert" ON broadcast_messages FOR INSERT WITH CHECK (get_my_role() = 'retailer' AND target_retailer_id = get_my_retailer_id());

-- ── 9. Run fines now ────────────────────────────────────────
SELECT * FROM calculate_and_apply_fines();

-- ── 10. Cron ────────────────────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('calculate-fines-daily'); EXCEPTION WHEN OTHERS THEN NULL; END;
    PERFORM cron.schedule('calculate-fines-daily', '0 0 * * *', 'SELECT calculate_and_apply_fines()');
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
DO $$ BEGIN RAISE NOTICE '✅ Migration 010 complete — fine engine fixed, auto-complete enabled'; END $$;
