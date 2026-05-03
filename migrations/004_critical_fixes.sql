-- ============================================================
-- EMI PORTAL — MIGRATION 004: Critical Fixes
-- Run in Supabase → SQL Editor → Run
-- Safe to run multiple times (idempotent)
-- ============================================================

-- ── 1. Add missing 'mobile' column to retailers table ────────────────────
ALTER TABLE retailers ADD COLUMN IF NOT EXISTS mobile TEXT;

-- ── 2. Add missing columns to payment_requests ──────────────────────────
-- These are used by the submit and approve-direct routes
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS scheduled_emi_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS collected_by_role TEXT CHECK (collected_by_role IN ('admin', 'retailer'));
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS collected_by_user_id UUID REFERENCES auth.users(id);
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS fine_for_emi_no INT;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS fine_due_date DATE;

-- ── 3. Auto-populate fine_amount on overdue EMIs ────────────────────────
-- This function updates fine_amount for overdue EMIs that haven't been
-- manually set and aren't waived. Run periodically or call before reads.
CREATE OR REPLACE FUNCTION apply_overdue_fines()
RETURNS VOID AS $$
DECLARE
  v_default_fine NUMERIC;
BEGIN
  SELECT default_fine_amount INTO v_default_fine FROM fine_settings WHERE id = 1;
  IF v_default_fine IS NULL THEN v_default_fine := 450; END IF;

  -- Only update the LOWEST unpaid EMI per customer (fine applies to first overdue)
  UPDATE emi_schedule es
  SET fine_amount = v_default_fine
  WHERE es.status = 'UNPAID'
    AND es.fine_waived = FALSE
    AND es.fine_amount = 0
    AND es.due_date < CURRENT_DATE
    AND es.emi_no = (
      SELECT MIN(e2.emi_no)
      FROM emi_schedule e2
      WHERE e2.customer_id = es.customer_id
        AND e2.status = 'UNPAID'
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION apply_overdue_fines() TO service_role;

-- Run it once now to backfill existing overdue EMIs
SELECT apply_overdue_fines();

-- ── 4. Update get_due_breakdown to also update fine_amount on the fly ───
-- This ensures the EMI schedule table shows correct fines even without cron
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
      -- Also update the DB so EMI schedule table shows correct value
      UPDATE emi_schedule
      SET fine_amount = v_fine_due
      WHERE id = v_next_emi.id AND fine_amount = 0 AND fine_waived = FALSE;
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

-- ── 5. Rollback notes ───────────────────────────────────────────────────
-- To rollback:
--   ALTER TABLE retailers DROP COLUMN IF EXISTS mobile;
--   ALTER TABLE payment_requests DROP COLUMN IF EXISTS scheduled_emi_amount;
--   ALTER TABLE payment_requests DROP COLUMN IF EXISTS collected_by_role;
--   ALTER TABLE payment_requests DROP COLUMN IF EXISTS collected_by_user_id;
--   ALTER TABLE payment_requests DROP COLUMN IF EXISTS fine_for_emi_no;
--   ALTER TABLE payment_requests DROP COLUMN IF EXISTS fine_due_date;
--   DROP FUNCTION IF EXISTS apply_overdue_fines();
-- Then re-run migrations/999_full_schema.sql to restore get_due_breakdown

-- ============================================================
-- DONE
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE 'Migration 004 completed successfully.';
  RAISE NOTICE 'Added: retailers.mobile, payment_requests.scheduled_emi_amount,';
  RAISE NOTICE '        collected_by_role, collected_by_user_id, fine_for_emi_no, fine_due_date';
  RAISE NOTICE 'Updated: get_due_breakdown() now auto-populates fine_amount';
  RAISE NOTICE 'Added: apply_overdue_fines() function';
END $$;
