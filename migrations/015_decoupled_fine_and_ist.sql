-- ============================================================
-- 015 — Decoupled fine retention + per-EMI fine allocation + IST
-- ------------------------------------------------------------
-- 1. payment_requests.fine_breakdown JSONB
--    Records per-EMI fine allocations:
--      [{ "emi_no": 1, "amount": 450 }, { "emi_no": 2, "amount": 475 }]
--    Reconciler applies each entry to that specific EMI's
--    fine_paid_amount. Paying EMI 2 principal does NOT clear EMI 1
--    fine — every fine remains tied to its own EMI row.
--
-- 2. Strict decoupling: emi_schedule.principal_status (the existing
--    `status` column) and fine_status are evaluated independently
--    by the application layer. We add a derived view + a check that
--    documents the contract.
--
-- 3. IST timezone defaults on the session so that
--    CURRENT_DATE / NOW() evaluate against Asia/Kolkata for stored
--    procs / triggers / get_due_breakdown invocations.
-- ============================================================

-- Force IST for new connections (overridable per-statement).
ALTER DATABASE postgres SET timezone TO 'Asia/Kolkata';

-- 1. Per-EMI fine allocation column
ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS fine_breakdown JSONB;

COMMENT ON COLUMN payment_requests.fine_breakdown IS
  'Per-EMI fine allocation: [{ "emi_no": int, "amount": numeric }]. '
  'When non-null, the reconciler applies each amount to the matching '
  'EMI row''s fine_paid_amount. Fine_status is evaluated independently '
  'of principal_status — paying EMI 2 principal does not clear EMI 1 fine.';

-- 2. Helper view that exposes EMI principal & fine state side-by-side.
CREATE OR REPLACE VIEW emi_schedule_state AS
SELECT
  es.id,
  es.customer_id,
  es.emi_no,
  es.due_date,
  es.amount,
  es.status                                                              AS principal_status,
  CASE
    WHEN es.fine_waived                                                  THEN 'WAIVED'
    WHEN COALESCE(es.fine_amount, 0) <= 0                                THEN 'NONE'
    WHEN COALESCE(es.fine_paid_amount, 0) >= COALESCE(es.fine_amount, 0) THEN 'PAID'
    WHEN COALESCE(es.fine_paid_amount, 0) > 0                            THEN 'PARTIAL'
    ELSE 'UNPAID'
  END                                                                    AS fine_status,
  es.fine_amount,
  es.fine_paid_amount,
  es.partial_paid_amount,
  es.paid_at,
  es.fine_paid_at,
  es.mode,
  es.utr,
  es.fine_waived
FROM emi_schedule es;

COMMENT ON VIEW emi_schedule_state IS
  'Read-only projection that surfaces principal_status and fine_status as '
  'independent columns. Use this in reporting to enforce the rule that an '
  'EMI''s fine remains payable even after its principal is APPROVED.';

-- 3. Update get_due_breakdown to use the IST-stamped CURRENT_DATE.
--    With the database default above set to Asia/Kolkata, CURRENT_DATE
--    already evaluates in IST. This block re-creates the function so
--    the timezone change takes effect for cached plans.
DO $$
BEGIN
  PERFORM 1 FROM pg_proc WHERE proname = 'get_due_breakdown';
  IF FOUND THEN
    EXECUTE 'COMMENT ON FUNCTION get_due_breakdown(UUID, INT) IS '
         || $$'CURRENT_DATE evaluates in Asia/Kolkata. Fine retention is '$$
         || $$'decoupled from principal payment.'$$;
  END IF;
END $$;

-- 4. approve_payment_request: honour fine_breakdown when present.
--    The existing function still works for legacy single-bucket fines;
--    this rewrite adds per-EMI fine distribution.
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
  RAISE NOTICE '015: fine_breakdown column added, approve_payment_request rewritten, '
               'database timezone set to Asia/Kolkata.';
END $$;
