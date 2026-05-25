-- =============================================
-- MIGRATION 002 — v2 ADDITIONS
-- Run this AFTER 001_initial.sql
-- =============================================

-- Add retail_pin to retailers (separate from login password)
ALTER TABLE retailers ADD COLUMN IF NOT EXISTS retail_pin TEXT;

-- Add collected_by tracking to emi_schedule
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS collected_by_role TEXT CHECK (collected_by_role IN ('admin', 'retailer'));
ALTER TABLE emi_schedule ADD COLUMN IF NOT EXISTS collected_by_user_id UUID REFERENCES auth.users(id);

-- Rename image url columns to match spec (add new ones, keep old)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_photo_url TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS aadhaar_front_url TEXT;  -- already exists from v1
ALTER TABLE customers ADD COLUMN IF NOT EXISTS aadhaar_back_url TEXT;   -- already exists from v1
ALTER TABLE customers ADD COLUMN IF NOT EXISTS bill_photo_url TEXT;

-- Add selected_emi_nos to payment_requests for multi-EMI selection
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS selected_emi_nos INT[];

-- =============================================
-- SEED: Super Admin user profile
-- Run after creating auth user telepoint@admin.local
-- =============================================
INSERT INTO profiles (user_id, role)
SELECT id, 'super_admin'
FROM auth.users
WHERE email = 'telepoint@admin.local'
ON CONFLICT (user_id) DO UPDATE SET role = 'super_admin';

-- =============================================
-- SEED: Fine settings default
-- =============================================
INSERT INTO fine_settings (id, default_fine_amount)
VALUES (1, 450)
ON CONFLICT (id) DO NOTHING;

-- =============================================
-- UPDATED get_due_breakdown FUNCTION
-- Now supports selected_emi_no parameter (for multi-EMI selection)
-- =============================================
CREATE OR REPLACE FUNCTION get_due_breakdown(p_customer_id UUID, p_selected_emi_no INT DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
  v_customer RECORD;
  v_next_emi RECORD;
  v_selected_emi RECORD;
  v_fine_setting RECORD;
  v_fine_due NUMERIC := 0;
  v_first_emi_charge_due NUMERIC := 0;
  v_emi_amount NUMERIC := 0;
  v_total_payable NUMERIC := 0;
  v_popup_first_emi_charge BOOLEAN := FALSE;
  v_popup_fine_due BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RETURN '{"error": "Customer not found"}'::JSONB;
  END IF;

  SELECT * INTO v_fine_setting FROM fine_settings WHERE id = 1;

  -- Get lowest unpaid EMI (next due)
  SELECT * INTO v_next_emi
  FROM emi_schedule
  WHERE customer_id = p_customer_id AND status = 'UNPAID'
  ORDER BY emi_no ASC LIMIT 1;

  -- If caller selected a specific EMI, use that for amount
  IF p_selected_emi_no IS NOT NULL THEN
    SELECT * INTO v_selected_emi
    FROM emi_schedule
    WHERE customer_id = p_customer_id AND emi_no = p_selected_emi_no AND status = 'UNPAID';
    IF FOUND THEN
      v_emi_amount := v_selected_emi.amount;
    END IF;
  ELSE
    v_emi_amount := COALESCE(v_next_emi.amount, 0);
  END IF;

  -- Fine: applies on the NEXT (lowest) unpaid EMI if overdue
  IF v_next_emi IS NOT NULL AND CURRENT_DATE > v_next_emi.due_date THEN
    v_fine_due := COALESCE(v_next_emi.fine_amount, 0);
    IF v_fine_due = 0 AND NOT v_next_emi.fine_waived THEN
      v_fine_due := v_fine_setting.default_fine_amount;
    END IF;
    IF v_next_emi.fine_waived THEN v_fine_due := 0; END IF;
    IF v_fine_due > 0 THEN v_popup_fine_due := TRUE; END IF;
  END IF;

  -- First EMI charge
  IF v_customer.first_emi_charge_amount > 0 AND v_customer.first_emi_charge_paid_at IS NULL THEN
    v_first_emi_charge_due := v_customer.first_emi_charge_amount;
    v_popup_first_emi_charge := TRUE;
  END IF;

  v_total_payable := v_emi_amount + v_fine_due + v_first_emi_charge_due;

  RETURN jsonb_build_object(
    'customer_id', p_customer_id,
    'customer_status', v_customer.status,
    'next_emi_no', v_next_emi.emi_no,
    'next_emi_amount', v_next_emi.amount,
    'next_emi_due_date', v_next_emi.due_date,
    'next_emi_status', v_next_emi.status,
    'selected_emi_no', COALESCE(p_selected_emi_no, v_next_emi.emi_no),
    'selected_emi_amount', v_emi_amount,
    'fine_due', v_fine_due,
    'first_emi_charge_due', v_first_emi_charge_due,
    'total_payable', v_total_payable,
    'popup_first_emi_charge', v_popup_first_emi_charge,
    'popup_fine_due', v_popup_fine_due,
    'is_overdue', (v_next_emi IS NOT NULL AND CURRENT_DATE > v_next_emi.due_date)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_due_breakdown(UUID, INT) TO authenticated;
