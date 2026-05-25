-- 014_partial_payment_and_hardening.sql
-- Adds partial-payment tracking, disables legacy auto-apply triggers,
-- and normalizes EMI/payment data for safer admin edits and deletions.

ALTER TABLE emi_schedule
  ADD COLUMN IF NOT EXISTS partial_paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS partial_paid_at TIMESTAMPTZ;

-- Expand status check to include PARTIALLY_PAID.
DO $$
BEGIN
  ALTER TABLE emi_schedule DROP CONSTRAINT IF EXISTS emi_schedule_status_check;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

ALTER TABLE emi_schedule
  ADD CONSTRAINT emi_schedule_status_check
  CHECK (status IN ('UNPAID', 'PENDING_APPROVAL', 'PARTIALLY_PAID', 'APPROVED'));

-- Legacy DB triggers auto-applied payments on payment_requests.status changes.
-- The app now reconciles request effects explicitly in API routes.
DROP TRIGGER IF EXISTS trg_auto_apply ON payment_requests;
DROP TRIGGER IF EXISTS trg_auto_apply_payment_on_approval ON payment_requests;
DROP FUNCTION IF EXISTS fn_auto_apply_payment_on_approval();

-- Backfill already-approved EMIs.
UPDATE emi_schedule
SET
  partial_paid_amount = CASE
    WHEN status = 'APPROVED' AND COALESCE(partial_paid_amount, 0) < amount THEN amount
    ELSE COALESCE(partial_paid_amount, 0)
  END,
  partial_paid_at = CASE
    WHEN status IN ('APPROVED', 'PARTIALLY_PAID') THEN COALESCE(partial_paid_at, paid_at, NOW())
    ELSE partial_paid_at
  END;

-- Normalize impossible states.
UPDATE emi_schedule
SET
  status = CASE
    WHEN COALESCE(partial_paid_amount, 0) >= amount THEN 'APPROVED'
    WHEN COALESCE(partial_paid_amount, 0) > 0 THEN 'PARTIALLY_PAID'
    ELSE 'UNPAID'
  END,
  paid_at = CASE
    WHEN COALESCE(partial_paid_amount, 0) >= amount THEN COALESCE(paid_at, NOW())
    ELSE NULL
  END,
  mode = CASE
    WHEN COALESCE(partial_paid_amount, 0) > 0 THEN mode
    ELSE NULL
  END,
  utr = CASE
    WHEN COALESCE(partial_paid_amount, 0) > 0 THEN utr
    ELSE NULL
  END,
  approved_by = CASE
    WHEN COALESCE(partial_paid_amount, 0) > 0 THEN approved_by
    ELSE NULL
  END,
  collected_by_role = CASE
    WHEN COALESCE(partial_paid_amount, 0) > 0 THEN collected_by_role
    ELSE NULL
  END,
  collected_by_user_id = CASE
    WHEN COALESCE(partial_paid_amount, 0) > 0 THEN collected_by_user_id
    ELSE NULL
  END;

-- Fine paid amount must never exceed fine amount unless historical data says more.
UPDATE emi_schedule
SET fine_paid_amount = GREATEST(0, COALESCE(fine_paid_amount, 0));

CREATE INDEX IF NOT EXISTS idx_emi_schedule_partial_status
  ON emi_schedule(customer_id, status, emi_no);

CREATE INDEX IF NOT EXISTS idx_emi_schedule_partial_paid
  ON emi_schedule(customer_id, partial_paid_amount);
