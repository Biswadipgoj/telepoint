-- 017_db_level_fine_update.sql
-- Persist late fines at the DB level.
--
-- Until now the fine was only ever *computed* on read (lib/fineCalc.ts and the
-- get_due_breakdown RPC). The stored emi_schedule.fine_amount went stale, which
-- mislead anything that trusts the stored value — most importantly the
-- completion check, which can mark a customer COMPLETE while a late fine is
-- still outstanding.
--
-- These functions write the calculated fine back into emi_schedule using the
-- exact same rules as the live calculator:
--   • Base fine (default ₹450) applied once the day after the due date.
--   • 30-day grace, then +weekly (default ₹25) every 7 days, until paid.
--   • Last EMI while still UNPAID: base repeats every 30 days, no weekly.
--   • PENDING_APPROVAL EMIs are frozen (left untouched).
--   • Fine never decreases (GREATEST of calc vs stored) so manual admin
--     overrides and already-accrued amounts are preserved.

-- ── Per-customer recalculation ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION recalc_customer_fines(p_customer_id UUID)
RETURNS INT AS $$
DECLARE
  v_base_fine   NUMERIC := 450;
  v_weekly      NUMERIC := 25;
  v_max_emi_no  INT;
  v_row         RECORD;
  v_days        INT;
  v_weeks       INT;
  v_calc        NUMERIC;
  v_new         NUMERIC;
  v_updated     INT := 0;
  v_pending_fine BOOLEAN := FALSE;
  v_open_emi    INT;
  v_customer    RECORD;
BEGIN
  SELECT COALESCE(default_fine_amount, 450), COALESCE(weekly_fine_increment, 25)
  INTO v_base_fine, v_weekly
  FROM fine_settings WHERE id = 1;

  SELECT MAX(emi_no) INTO v_max_emi_no
  FROM emi_schedule WHERE customer_id = p_customer_id;

  FOR v_row IN
    SELECT * FROM emi_schedule
    WHERE customer_id = p_customer_id
      AND fine_waived = FALSE
      AND status <> 'PENDING_APPROVAL'          -- frozen while awaiting verdict
      AND (
        (status IN ('UNPAID', 'PARTIALLY_PAID') AND due_date < CURRENT_DATE)
        OR (COALESCE(fine_amount, 0) > COALESCE(fine_paid_amount, 0))
      )
  LOOP
    v_days := GREATEST(0, (CURRENT_DATE - v_row.due_date)::INT);

    IF v_days = 0 THEN
      v_calc := COALESCE(v_row.fine_amount, 0);
    ELSIF v_row.emi_no = v_max_emi_no AND v_row.status <> 'APPROVED' THEN
      v_calc := CEIL(v_days::NUMERIC / 30) * v_base_fine;
    ELSIF v_days <= 30 THEN
      v_calc := v_base_fine;
    ELSE
      v_weeks := FLOOR((v_days - 30)::NUMERIC / 7);
      v_calc := v_base_fine + (v_weeks * v_weekly);
    END IF;

    -- Never decrease — preserve manual overrides and prior accrual.
    v_new := GREATEST(v_calc, COALESCE(v_row.fine_amount, 0));

    IF v_new <> COALESCE(v_row.fine_amount, 0) THEN
      UPDATE emi_schedule
      SET fine_amount             = v_new,
          fine_last_calculated_at = NOW(),
          updated_at              = NOW()
      WHERE id = v_row.id;
      v_updated := v_updated + 1;
    END IF;

    IF v_new > COALESCE(v_row.fine_paid_amount, 0) THEN
      v_pending_fine := TRUE;
    END IF;
  END LOOP;

  -- Safety net: a COMPLETE customer that now carries an unpaid fine should be
  -- reopened so the outstanding amount is not lost. (SETTLED is intentionally
  -- left alone — settlement waives the remainder.)
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF FOUND AND v_customer.status = 'COMPLETE' AND v_pending_fine THEN
    SELECT COUNT(*) INTO v_open_emi
    FROM emi_schedule
    WHERE customer_id = p_customer_id
      AND status IN ('UNPAID', 'PENDING_APPROVAL', 'PARTIALLY_PAID');
    UPDATE customers
    SET status = 'RUNNING', completion_date = NULL, updated_at = NOW()
    WHERE id = p_customer_id;
  END IF;

  RETURN v_updated;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── Portfolio-wide recalculation ─────────────────────────────────────────────
-- Only touches customers that can still accrue (RUNNING / COMPLETE) and that
-- have at least one overdue-unpaid or fine-bearing EMI.
CREATE OR REPLACE FUNCTION recalc_all_fines()
RETURNS INT AS $$
DECLARE
  v_cust   UUID;
  v_total  INT := 0;
BEGIN
  FOR v_cust IN
    SELECT DISTINCT c.id
    FROM customers c
    JOIN emi_schedule e ON e.customer_id = c.id
    WHERE c.status IN ('RUNNING', 'COMPLETE')
      AND e.fine_waived = FALSE
      AND e.status <> 'PENDING_APPROVAL'
      AND (
        (e.status IN ('UNPAID', 'PARTIALLY_PAID') AND e.due_date < CURRENT_DATE)
        OR (COALESCE(e.fine_amount, 0) > COALESCE(e.fine_paid_amount, 0))
      )
  LOOP
    v_total := v_total + recalc_customer_fines(v_cust);
  END LOOP;
  RETURN v_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION recalc_customer_fines(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION recalc_all_fines()          TO service_role;

-- ── Daily schedule (pg_cron) ─────────────────────────────────────────────────
-- Runs at 18:30 UTC = 00:00 IST, just after fines tick over to a new day.
-- Guarded so the migration still applies where pg_cron is unavailable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('recalc-fines-daily')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'recalc-fines-daily');
    PERFORM cron.schedule('recalc-fines-daily', '30 18 * * *', $cron$SELECT recalc_all_fines();$cron$);
  END IF;
END $$;
