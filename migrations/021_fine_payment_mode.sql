-- ============================================================
-- 021 — Persist the payment METHOD (mode) for fine payments
-- ------------------------------------------------------------
-- Migration 019 added emi_schedule.fine_utr. The fine's payment method
-- (CASH vs UPI) was still not stored per EMI — the EMI's own `mode`
-- column reflects the principal payment and stays NULL for fine-only
-- payments. This adds emi_schedule.fine_mode and stamps it from the
-- request in both approval paths (this DB function + the JS reconciler).
-- ============================================================

ALTER TABLE emi_schedule
  ADD COLUMN IF NOT EXISTS fine_mode TEXT;

COMMENT ON COLUMN emi_schedule.fine_mode IS
  'Payment method (CASH / UPI) for the fine payment applied to this EMI. '
  'Mirrors payment_requests.mode so per-EMI views can show the fine''s method '
  'independently of the principal payment.';

-- Rewrite approve_payment_request to also persist fine_mode (keeps fine_utr).
CREATE OR REPLACE FUNCTION approve_payment_request(
  p_request_id UUID,
  p_admin_id   UUID,
  p_remark     TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  v_request      RECORD;
  v_item         RECORD;
  v_fine_entry   RECORD;
  v_now          TIMESTAMPTZ := NOW();
  v_emi_ids      UUID[] := '{}';
  v_unpaid_count INT;
  v_target_emi   UUID;
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

  -- STEP 1: principal updates on linked EMIs
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

  -- STEP 2: fines — per-EMI breakdown wins when present
  IF v_request.fine_breakdown IS NOT NULL
     AND jsonb_typeof(v_request.fine_breakdown) = 'array'
     AND jsonb_array_length(v_request.fine_breakdown) > 0 THEN
    FOR v_fine_entry IN
      SELECT
        (entry->>'emi_no')::INT      AS emi_no,
        (entry->>'amount')::NUMERIC  AS amount
      FROM jsonb_array_elements(v_request.fine_breakdown) AS entry
    LOOP
      IF v_fine_entry.amount IS NULL OR v_fine_entry.amount <= 0 THEN
        CONTINUE;
      END IF;
      UPDATE emi_schedule
      SET
        fine_paid_amount = LEAST(
          COALESCE(fine_amount, 0),
          COALESCE(fine_paid_amount, 0) + v_fine_entry.amount
        ),
        fine_paid_at = COALESCE(fine_paid_at, v_now),
        fine_utr     = COALESCE(fine_utr, v_request.utr),
        fine_mode    = COALESCE(fine_mode, v_request.mode),
        updated_at   = v_now
      WHERE customer_id = v_request.customer_id
        AND emi_no      = v_fine_entry.emi_no;
    END LOOP;
  ELSIF COALESCE(v_request.fine_amount, 0) > 0 THEN
    -- Legacy single-bucket fine — apply to fine_for_emi_no or the lowest
    -- linked EMI.
    UPDATE emi_schedule
    SET
      fine_paid_amount = LEAST(
        COALESCE(fine_amount, 0),
        COALESCE(fine_paid_amount, 0) + v_request.fine_amount
      ),
      fine_paid_at = COALESCE(fine_paid_at, v_now),
      fine_utr     = COALESCE(fine_utr, v_request.utr),
      fine_mode    = COALESCE(fine_mode, v_request.mode),
      updated_at   = v_now
    WHERE customer_id = v_request.customer_id
      AND emi_no      = COALESCE(
        v_request.fine_for_emi_no,
        (SELECT MIN(pri.emi_no)
           FROM payment_request_items pri
          WHERE pri.payment_request_id = p_request_id)
      );
  END IF;

  -- STEP 3: first EMI charge
  IF COALESCE(v_request.first_emi_charge_amount, 0) > 0 THEN
    UPDATE customers
    SET first_emi_charge_paid_at = COALESCE(first_emi_charge_paid_at, v_now),
        updated_at = v_now
    WHERE id = v_request.customer_id;
  END IF;

  -- STEP 4: mark request approved
  UPDATE payment_requests
  SET status      = 'APPROVED',
      approved_by = p_admin_id,
      approved_at = v_now,
      updated_at  = v_now,
      notes       = CASE
                      WHEN p_remark IS NOT NULL
                      THEN COALESCE(notes || E'\n', '') || 'Admin remark: ' || p_remark
                      ELSE notes
                    END
  WHERE id = p_request_id;

  -- STEP 5: auto-complete only if EMI principals AND fines AND charge all clear
  SELECT COUNT(*) INTO v_unpaid_count
  FROM emi_schedule
  WHERE customer_id = v_request.customer_id
    AND status IN ('UNPAID', 'PENDING_APPROVAL', 'PARTIALLY_PAID');

  DECLARE
    v_fine_pending   BOOLEAN;
    v_charge_pending BOOLEAN;
    v_cust           RECORD;
  BEGIN
    SELECT * INTO v_cust FROM customers WHERE id = v_request.customer_id;
    v_fine_pending := EXISTS (
      SELECT 1 FROM emi_schedule
      WHERE customer_id = v_request.customer_id
        AND fine_waived = FALSE
        AND COALESCE(fine_amount, 0) > COALESCE(fine_paid_amount, 0)
    );
    v_charge_pending := COALESCE(v_cust.first_emi_charge_amount, 0) > 0
                    AND v_cust.first_emi_charge_paid_at IS NULL;

    IF v_unpaid_count = 0 AND NOT v_fine_pending AND NOT v_charge_pending THEN
      UPDATE customers
      SET status = 'COMPLETE', completion_date = v_now::DATE, updated_at = v_now
      WHERE id = v_request.customer_id AND status = 'RUNNING';
    END IF;
  END;

  INSERT INTO audit_log (actor_user_id, actor_role, action, table_name, record_id, before_data, after_data, remark)
  VALUES (
    p_admin_id, 'super_admin', 'APPROVE_PAYMENT',
    'payment_requests', p_request_id,
    jsonb_build_object('status', 'PENDING'),
    jsonb_build_object('status', 'APPROVED', 'emi_ids', to_jsonb(v_emi_ids), 'approved_at', v_now,
                       'fine_breakdown', v_request.fine_breakdown),
    p_remark
  );

  RETURN jsonb_build_object('success', true, 'request_id', p_request_id,
                            'emi_ids', to_jsonb(v_emi_ids), 'approved_at', v_now);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION approve_payment_request(UUID, UUID, TEXT) TO service_role;

DO $$
BEGIN
  RAISE NOTICE '021: emi_schedule.fine_mode added; approve_payment_request now stamps fine_mode.';
END $$;
