-- ============================================================
-- MIGRATION 007: Automatic Fine Engine + UTR + EMI Start Date
-- Run in Supabase SQL Editor (idempotent)
-- ============================================================

-- ── 1. NEW COLUMNS ON emi_schedule ──────────────────────────
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS fine_last_calculated_at TIMESTAMPTZ;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS fine_paid_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS fine_paid_at TIMESTAMPTZ;
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS utr TEXT;

-- ── 2. NEW COLUMNS ON customers ─────────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS emi_start_date DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS emi_card_photo_url TEXT;

-- ── 3. NEW COLUMNS ON payment_requests ──────────────────────
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS utr TEXT;

-- ── 4. Update customer status constraint (if not done) ──────
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_status_check
  CHECK (status IN ('RUNNING', 'COMPLETE', 'SETTLED', 'NPA'));

-- ── 5. AUTOMATIC FINE ENGINE ────────────────────────────────
-- Formula: base_fine = 450, weekly_increment = 25
-- fine = base_fine + (weeks_overdue × weekly_increment)
-- Applies to UNPAID EMIs where due_date < today
-- Only recalculates if fine_paid_amount < calculated fine

CREATE OR REPLACE FUNCTION calculate_and_apply_fines()
RETURNS TABLE(updated_count INT) AS $$
DECLARE
  v_base_fine NUMERIC;
  v_weekly_increment NUMERIC := 25;
  v_count INT := 0;
  v_emi RECORD;
  v_weeks INT;
  v_calculated_fine NUMERIC;
BEGIN
  -- Get base fine from settings
  SELECT default_fine_amount INTO v_base_fine FROM fine_settings WHERE id = 1;
  IF v_base_fine IS NULL THEN v_base_fine := 450; END IF;

  -- Loop through all overdue UNPAID EMIs
  FOR v_emi IN
    SELECT es.id, es.due_date, es.fine_amount, es.fine_paid_amount
    FROM emi_schedule es
    JOIN customers c ON c.id = es.customer_id
    WHERE es.status = 'UNPAID'
      AND es.due_date < CURRENT_DATE
      AND c.status = 'RUNNING'
  LOOP
    -- Calculate weeks overdue (full weeks only)
    v_weeks := GREATEST(0, FLOOR((CURRENT_DATE - v_emi.due_date - 1) / 7));
    
    -- Calculate total fine
    v_calculated_fine := v_base_fine + (v_weeks * v_weekly_increment);
    
    -- Only update if fine changed
    IF v_calculated_fine != COALESCE(v_emi.fine_amount, 0) THEN
      UPDATE emi_schedule
      SET fine_amount = v_calculated_fine,
          fine_last_calculated_at = NOW(),
          updated_at = NOW()
      WHERE id = v_emi.id;
      
      v_count := v_count + 1;
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION calculate_and_apply_fines() TO authenticated;
GRANT EXECUTE ON FUNCTION calculate_and_apply_fines() TO service_role;

-- ── 6. Run fine engine now to backfill ──────────────────────
SELECT * FROM calculate_and_apply_fines();

-- ── 7. Updated get_due_breakdown that reads DB fines ────────
-- Total fine = SUM of all overdue EMI fines minus paid amounts
CREATE OR REPLACE FUNCTION get_due_breakdown(
  p_customer_id    UUID,
  p_selected_emi_no INT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_customer             RECORD;
  v_next_emi             RECORD;
  v_selected_emi         RECORD;
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

  -- Recalculate fines for this customer first
  PERFORM calculate_and_apply_fines();

  -- Lowest unpaid EMI
  SELECT * INTO v_next_emi
  FROM emi_schedule
  WHERE customer_id = p_customer_id AND status = 'UNPAID'
  ORDER BY emi_no ASC LIMIT 1;

  -- Selected EMI amount
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

  -- Total fine = sum of ALL overdue EMI fines minus paid amounts
  SELECT COALESCE(SUM(
    GREATEST(0, COALESCE(fine_amount, 0) - COALESCE(fine_paid_amount, 0))
  ), 0) INTO v_fine_due
  FROM emi_schedule
  WHERE customer_id = p_customer_id
    AND status = 'UNPAID'
    AND due_date < CURRENT_DATE;

  IF v_fine_due > 0 THEN v_popup_fine := TRUE; END IF;

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

-- ── 8. Updated EMI schedule generator with emi_start_date ───
CREATE OR REPLACE FUNCTION generate_emi_schedule(p_customer_id UUID)
RETURNS VOID AS $$
DECLARE
  v_customer RECORD;
  v_start_date DATE;
  v_due_date DATE;
  i INT;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;

  DELETE FROM emi_schedule WHERE customer_id = p_customer_id;

  -- Use emi_start_date if set, otherwise derive from purchase_date
  v_start_date := COALESCE(v_customer.emi_start_date, v_customer.purchase_date);

  FOR i IN 1..v_customer.emi_tenure LOOP
    v_due_date :=
      DATE_TRUNC('month', v_start_date + (i || ' months')::INTERVAL)
      + (v_customer.emi_due_day - 1) * INTERVAL '1 day';

    -- Clamp to end of month
    IF v_due_date > (
      DATE_TRUNC('month', v_start_date + (i || ' months')::INTERVAL)
      + INTERVAL '1 month - 1 day'
    ) THEN
      v_due_date :=
        DATE_TRUNC('month', v_start_date + (i || ' months')::INTERVAL)
        + INTERVAL '1 month - 1 day';
    END IF;

    INSERT INTO emi_schedule (customer_id, emi_no, due_date, amount)
    VALUES (p_customer_id, i, v_due_date, v_customer.emi_amount);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 9. Supabase Cron (if pg_cron available) ─────────────────
-- This runs fine calculation daily at midnight.
-- If pg_cron is not enabled, fine calculates on each get_due_breakdown call.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'calculate-fines-daily',
      '0 0 * * *',
      'SELECT calculate_and_apply_fines()'
    );
    RAISE NOTICE 'pg_cron job scheduled: calculate-fines-daily';
  ELSE
    RAISE NOTICE 'pg_cron not available. Fines will calculate on-demand via get_due_breakdown().';
  END IF;
END $$;

-- ── 10. Reload schema cache ─────────────────────────────────
NOTIFY pgrst, 'reload schema';

DO $$ BEGIN
  RAISE NOTICE 'Migration 007 complete.';
  RAISE NOTICE 'Added: fine engine, UTR, emi_start_date, emi_card_photo_url';
END $$;
