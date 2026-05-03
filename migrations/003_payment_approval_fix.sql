-- =============================================
-- MIGRATION 003 — PAYMENT APPROVAL BUG FIX
-- Run this in Supabase SQL Editor
-- =============================================

-- ─────────────────────────────────────────────
-- FIX 1: Backfill existing payment_request_items
-- that were incorrectly stored with emi_id column
-- (They stored the value but in wrong column name)
-- This migration assumes column is emi_schedule_id
-- per the original schema — nothing to rename.
-- ─────────────────────────────────────────────

-- Verify the column exists (it should per 001_initial.sql)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payment_request_items'
      AND column_name = 'emi_schedule_id'
  ) THEN
    RAISE EXCEPTION 'Column payment_request_items.emi_schedule_id missing — check migration 001';
  END IF;
END $$;

-- ─────────────────────────────────────────────
-- FIX 2: Back-fill any orphaned PENDING payment
-- requests that have no items but have selected_emi_nos.
-- This repairs data from the buggy submit route.
-- ─────────────────────────────────────────────
INSERT INTO payment_request_items (payment_request_id, emi_schedule_id, emi_no, amount)
SELECT
  pr.id                    AS payment_request_id,
  es.id                    AS emi_schedule_id,
  es.emi_no                AS emi_no,
  pr.total_emi_amount / GREATEST(array_length(pr.selected_emi_nos, 1), 1) AS amount
FROM payment_requests pr
JOIN LATERAL UNNEST(pr.selected_emi_nos) AS sn(emi_no) ON TRUE
JOIN emi_schedule es
  ON es.customer_id = pr.customer_id
  AND es.emi_no = sn.emi_no
WHERE pr.status = 'PENDING'
  AND pr.selected_emi_nos IS NOT NULL
  AND array_length(pr.selected_emi_nos, 1) > 0
  -- Only backfill requests that have NO items yet
  AND NOT EXISTS (
    SELECT 1 FROM payment_request_items pri
    WHERE pri.payment_request_id = pr.id
  )
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────
-- FIX 3: Safety trigger — when payment_requests
-- status flips to APPROVED, auto-apply the payment
-- on emi_schedule. This is a safety net that fires
-- even if the API route partially fails.
-- ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_auto_apply_payment_on_approval()
RETURNS TRIGGER AS $$
DECLARE
  v_item RECORD;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  -- Only fire when transitioning PENDING → APPROVED
  IF OLD.status = 'PENDING' AND NEW.status = 'APPROVED' THEN

    -- Mark all linked EMIs as APPROVED
    FOR v_item IN
      SELECT emi_schedule_id
      FROM payment_request_items
      WHERE payment_request_id = NEW.id
    LOOP
      UPDATE emi_schedule
      SET
        status               = 'APPROVED',
        paid_at              = COALESCE(paid_at, v_now),   -- don't overwrite if API already set it
        mode                 = COALESCE(mode, NEW.mode),
        approved_by          = COALESCE(approved_by, NEW.approved_by),
        collected_by_role    = COALESCE(collected_by_role, 'retailer')
      WHERE id = v_item.emi_schedule_id
        AND status != 'APPROVED';                          -- idempotent — skip already-approved rows
    END LOOP;

    -- Mark first EMI charge paid if applicable
    IF NEW.first_emi_charge_amount > 0 THEN
      UPDATE customers
      SET first_emi_charge_paid_at = COALESCE(first_emi_charge_paid_at, v_now)
      WHERE id = NEW.customer_id
        AND first_emi_charge_paid_at IS NULL;
    END IF;

    -- Record fine as PAID (keep fine_amount for audit trail)
    IF NEW.fine_amount > 0 THEN
      UPDATE emi_schedule
      SET fine_paid_amount = COALESCE(fine_paid_amount, 0) + NEW.fine_amount,
          fine_paid_at = NOW()
      WHERE customer_id = NEW.customer_id
        AND emi_no = (
          SELECT MIN(pri.emi_no)
          FROM payment_request_items pri
          WHERE pri.payment_request_id = NEW.id
        );
    END IF;

  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop and recreate trigger (idempotent)
DROP TRIGGER IF EXISTS trg_auto_apply_payment_on_approval ON payment_requests;

CREATE TRIGGER trg_auto_apply_payment_on_approval
  AFTER UPDATE OF status ON payment_requests
  FOR EACH ROW
  EXECUTE FUNCTION fn_auto_apply_payment_on_approval();

-- ─────────────────────────────────────────────
-- FIX 4: Create a stored procedure for atomic
-- approval — called from server route via rpc()
-- for true atomicity within a single DB transaction
-- ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION approve_payment_request(
  p_request_id  UUID,
  p_admin_id    UUID,
  p_remark      TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_request     RECORD;
  v_item        RECORD;
  v_now         TIMESTAMPTZ := NOW();
  v_emi_ids     UUID[] := '{}';
  v_unpaid_count INT;
BEGIN
  -- Lock the row for update to prevent race conditions
  SELECT * INTO v_request
  FROM payment_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Request not found');
  END IF;

  -- Idempotency: already approved
  IF v_request.status = 'APPROVED' THEN
    RETURN jsonb_build_object('success', true, 'already_approved', true);
  END IF;

  IF v_request.status != 'PENDING' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Request status is ' || v_request.status || ' — cannot approve'
    );
  END IF;

  -- Step 1: Mark EMIs APPROVED
  FOR v_item IN
    SELECT pri.emi_schedule_id, pri.emi_no
    FROM payment_request_items pri
    WHERE pri.payment_request_id = p_request_id
  LOOP
    UPDATE emi_schedule
    SET
      status            = 'APPROVED',
      paid_at           = v_now,
      mode              = v_request.mode,
      approved_by       = p_admin_id,
      collected_by_role = 'retailer',
      collected_by_user_id = v_request.submitted_by
    WHERE id = v_item.emi_schedule_id;

    v_emi_ids := v_emi_ids || v_item.emi_schedule_id;
  END LOOP;

  -- Step 2: Record fine as PAID (keep fine_amount intact)
  IF v_request.fine_amount > 0 THEN
    UPDATE emi_schedule
    SET fine_paid_amount = COALESCE(fine_paid_amount, 0) + v_request.fine_amount,
        fine_paid_at = NOW()
    WHERE customer_id = v_request.customer_id
      AND emi_no = (
        SELECT MIN(pri.emi_no)
        FROM payment_request_items pri
        WHERE pri.payment_request_id = p_request_id
      );
  END IF;

  -- Step 3: Mark first EMI charge paid
  IF v_request.first_emi_charge_amount > 0 THEN
    UPDATE customers
    SET first_emi_charge_paid_at = v_now
    WHERE id = v_request.customer_id
      AND first_emi_charge_paid_at IS NULL;
  END IF;

  -- Step 4: Update request status
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

  -- Step 5: Auto-complete customer if all EMIs done
  SELECT COUNT(*) INTO v_unpaid_count
  FROM emi_schedule
  WHERE customer_id = v_request.customer_id
    AND status IN ('UNPAID', 'PENDING_APPROVAL');

  IF v_unpaid_count = 0 THEN
    UPDATE customers
    SET status = 'COMPLETE', completion_date = v_now::DATE
    WHERE id = v_request.customer_id
      AND status = 'RUNNING';
  END IF;

  -- Step 6: Audit log
  INSERT INTO audit_log (
    actor_user_id, actor_role, action, table_name, record_id,
    before_data, after_data, remark
  ) VALUES (
    p_admin_id, 'super_admin', 'APPROVE_PAYMENT', 'payment_requests', p_request_id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object(
      'status', 'APPROVED',
      'emi_ids', to_jsonb(v_emi_ids),
      'approved_at', v_now
    ),
    p_remark
  );

  RETURN jsonb_build_object(
    'success',     true,
    'request_id',  p_request_id,
    'emi_ids',     to_jsonb(v_emi_ids),
    'approved_at', v_now
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execution to authenticated users (API route will call it via service role)
GRANT EXECUTE ON FUNCTION approve_payment_request(UUID, UUID, TEXT) TO service_role;

-- ─────────────────────────────────────────────
-- VERIFY
-- ─────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE 'Migration 003 completed successfully.';
  RAISE NOTICE 'Trigger: trg_auto_apply_payment_on_approval installed.';
  RAISE NOTICE 'Function: approve_payment_request() installed.';
END $$;
