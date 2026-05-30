-- 016_emi_due_day_up_to_30.sql
-- Raise the allowed EMI due day from a max of 28 to a max of 30, and make the
-- EMI-schedule generator clamp the due day to the last calendar day of months
-- that are shorter than the chosen day (e.g. due day 30 in February falls back
-- to 28/29, due day 30 lands on the 30th everywhere else). Without the clamp a
-- due day of 29/30 would silently roll over into the following month.

-- 1) Widen the constraint -----------------------------------------------------
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_emi_due_day_check;
ALTER TABLE customers
  ADD CONSTRAINT customers_emi_due_day_check CHECK (emi_due_day BETWEEN 1 AND 30);

-- 2) Regenerate the schedule function with month-end clamping ------------------
CREATE OR REPLACE FUNCTION fn_generate_emi_schedule()
RETURNS TRIGGER AS $$
DECLARE
  v_start_date  DATE;
  v_due_day     INT;
  v_i           INT;
  v_due_date    DATE;
  v_month_start DATE;
  v_last_day    DATE;
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
    v_month_start := DATE_TRUNC('month', (v_start_date + (v_i || ' months')::INTERVAL))::DATE;
    -- Last calendar day of that month (handles Feb / 30-day months)
    v_last_day    := (v_month_start + INTERVAL '1 month - 1 day')::DATE;
    -- Adjust to emi_due_day, clamping to month end when the day overflows
    -- (e.g. due_day 30 in February falls back to 28/29).
    v_due_date    := LEAST(v_month_start + (v_due_day - 1), v_last_day);

    -- Only insert if this EMI doesn't already exist
    INSERT INTO emi_schedule (customer_id, emi_no, due_date, amount)
    VALUES (NEW.id, v_i, v_due_date, NEW.emi_amount)
    ON CONFLICT (customer_id, emi_no) DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
