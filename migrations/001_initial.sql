-- =============================================
-- EMI MANAGEMENT PORTAL - INITIAL MIGRATION
-- =============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- PROFILES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'retailer')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- RETAILERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS retailers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- CUSTOMERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  retailer_id UUID NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  customer_name TEXT NOT NULL,
  father_name TEXT,
  aadhaar TEXT CHECK (LENGTH(aadhaar) = 12),
  voter_id TEXT,
  address TEXT,
  landmark TEXT,
  mobile TEXT NOT NULL CHECK (LENGTH(mobile) = 10),
  alternate_number_1 TEXT,
  alternate_number_2 TEXT,
  model_no TEXT,
  imei TEXT UNIQUE NOT NULL CHECK (LENGTH(imei) = 15),
  purchase_value NUMERIC(12,2) NOT NULL,
  down_payment NUMERIC(12,2) DEFAULT 0,
  disburse_amount NUMERIC(12,2),
  purchase_date DATE NOT NULL,
  emi_due_day INT CHECK (emi_due_day BETWEEN 1 AND 28),
  emi_amount NUMERIC(12,2) NOT NULL,
  emi_tenure INT NOT NULL CHECK (emi_tenure BETWEEN 1 AND 12),
  first_emi_charge_amount NUMERIC(12,2) DEFAULT 0,
  first_emi_charge_paid_at TIMESTAMPTZ,
  box_no TEXT,
  photo_url TEXT,
  aadhaar_front_url TEXT,
  aadhaar_back_url TEXT,
  bill_url TEXT,
  card_url TEXT,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETE')),
  completion_remark TEXT,
  completion_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- EMI SCHEDULE TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS emi_schedule (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  emi_no INT NOT NULL,
  due_date DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID', 'PENDING_APPROVAL', 'APPROVED')),
  paid_at TIMESTAMPTZ,
  mode TEXT CHECK (mode IN ('CASH', 'UPI')),
  approved_by UUID REFERENCES auth.users(id),
  fine_amount NUMERIC(12,2) DEFAULT 0,
  fine_waived BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, emi_no)
);

-- =============================================
-- PAYMENT REQUESTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS payment_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  retailer_id UUID NOT NULL REFERENCES retailers(id),
  submitted_by UUID REFERENCES auth.users(id),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  mode TEXT NOT NULL CHECK (mode IN ('CASH', 'UPI')),
  total_emi_amount NUMERIC(12,2) DEFAULT 0,
  fine_amount NUMERIC(12,2) DEFAULT 0,
  first_emi_charge_amount NUMERIC(12,2) DEFAULT 0,
  total_amount NUMERIC(12,2) NOT NULL,
  receipt_url TEXT,
  notes TEXT,
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  rejected_by UUID REFERENCES auth.users(id),
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- PAYMENT REQUEST ITEMS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS payment_request_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_request_id UUID NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  emi_schedule_id UUID NOT NULL REFERENCES emi_schedule(id),
  emi_no INT NOT NULL,
  amount NUMERIC(12,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- AUDIT LOG TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id UUID REFERENCES auth.users(id),
  actor_role TEXT,
  action TEXT NOT NULL,
  table_name TEXT,
  record_id UUID,
  before_data JSONB,
  after_data JSONB,
  remark TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- FINE SETTINGS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS fine_settings (
  id INT PRIMARY KEY DEFAULT 1,
  default_fine_amount NUMERIC(12,2) DEFAULT 450,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id),
  CHECK (id = 1)
);

INSERT INTO fine_settings (id, default_fine_amount) VALUES (1, 450) ON CONFLICT DO NOTHING;

-- =============================================
-- INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_customers_imei ON customers(imei);
CREATE INDEX IF NOT EXISTS idx_customers_aadhaar ON customers(aadhaar);
CREATE INDEX IF NOT EXISTS idx_customers_mobile ON customers(mobile);
CREATE INDEX IF NOT EXISTS idx_customers_retailer_id ON customers(retailer_id);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers USING gin(to_tsvector('english', customer_name));
CREATE INDEX IF NOT EXISTS idx_emi_schedule_customer_id ON emi_schedule(customer_id);
CREATE INDEX IF NOT EXISTS idx_emi_schedule_due_date ON emi_schedule(due_date);
CREATE INDEX IF NOT EXISTS idx_emi_schedule_status ON emi_schedule(status);
CREATE INDEX IF NOT EXISTS idx_payment_requests_customer_id ON payment_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_retailer_id ON payment_requests(retailer_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status);

-- =============================================
-- DUE BREAKDOWN FUNCTION
-- =============================================
CREATE OR REPLACE FUNCTION get_due_breakdown(p_customer_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_customer RECORD;
  v_next_emi RECORD;
  v_fine_setting RECORD;
  v_fine_due NUMERIC := 0;
  v_first_emi_charge_due NUMERIC := 0;
  v_total_payable NUMERIC := 0;
  v_popup_first_emi_charge BOOLEAN := FALSE;
  v_popup_fine_due BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN
    RETURN '{"error": "Customer not found"}'::JSONB;
  END IF;

  SELECT * INTO v_fine_setting FROM fine_settings WHERE id = 1;

  -- Get next unpaid EMI
  SELECT * INTO v_next_emi
  FROM emi_schedule
  WHERE customer_id = p_customer_id AND status = 'UNPAID'
  ORDER BY emi_no ASC
  LIMIT 1;

  -- Fine calculation: only if next unpaid EMI is overdue
  IF v_next_emi IS NOT NULL AND CURRENT_DATE > v_next_emi.due_date THEN
    v_fine_due := COALESCE(v_next_emi.fine_amount, v_fine_setting.default_fine_amount);
    IF v_next_emi.fine_waived THEN v_fine_due := 0; END IF;
    IF v_fine_due > 0 THEN v_popup_fine_due := TRUE; END IF;
  END IF;

  -- First EMI charge
  IF v_customer.first_emi_charge_amount > 0 AND v_customer.first_emi_charge_paid_at IS NULL THEN
    v_first_emi_charge_due := v_customer.first_emi_charge_amount;
    v_popup_first_emi_charge := TRUE;
  END IF;

  v_total_payable := COALESCE(v_next_emi.amount, 0) + v_fine_due + v_first_emi_charge_due;

  RETURN jsonb_build_object(
    'customer_id', p_customer_id,
    'customer_status', v_customer.status,
    'next_emi_no', v_next_emi.emi_no,
    'next_emi_amount', v_next_emi.amount,
    'next_emi_due_date', v_next_emi.due_date,
    'next_emi_status', v_next_emi.status,
    'fine_due', v_fine_due,
    'first_emi_charge_due', v_first_emi_charge_due,
    'total_payable', v_total_payable,
    'popup_first_emi_charge', v_popup_first_emi_charge,
    'popup_fine_due', v_popup_fine_due,
    'is_overdue', (v_next_emi IS NOT NULL AND CURRENT_DATE > v_next_emi.due_date)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- AUTO-GENERATE EMI SCHEDULE FUNCTION
-- =============================================
CREATE OR REPLACE FUNCTION generate_emi_schedule(p_customer_id UUID)
RETURNS VOID AS $$
DECLARE
  v_customer RECORD;
  v_due_date DATE;
  i INT;
BEGIN
  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  
  -- Delete existing schedule
  DELETE FROM emi_schedule WHERE customer_id = p_customer_id;
  
  -- Generate schedule
  FOR i IN 1..v_customer.emi_tenure LOOP
    -- Calculate due date: purchase_date + i months, set to emi_due_day
    v_due_date := DATE_TRUNC('month', v_customer.purchase_date + (i || ' months')::INTERVAL) 
                  + (v_customer.emi_due_day - 1) * INTERVAL '1 day';
    
    -- Ensure due day doesn't exceed month end
    IF v_due_date > (DATE_TRUNC('month', v_customer.purchase_date + (i || ' months')::INTERVAL) + INTERVAL '1 month - 1 day') THEN
      v_due_date := DATE_TRUNC('month', v_customer.purchase_date + (i || ' months')::INTERVAL) + INTERVAL '1 month - 1 day';
    END IF;

    INSERT INTO emi_schedule (customer_id, emi_no, due_date, amount)
    VALUES (p_customer_id, i, v_due_date, v_customer.emi_amount);
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================
-- TRIGGER: Auto-generate EMI on customer create
-- =============================================
CREATE OR REPLACE FUNCTION trigger_generate_emi_schedule()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM generate_emi_schedule(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS after_customer_insert ON customers;
CREATE TRIGGER after_customer_insert
  AFTER INSERT ON customers
  FOR EACH ROW
  EXECUTE FUNCTION trigger_generate_emi_schedule();

-- Also re-generate on tenure/amount change
CREATE OR REPLACE FUNCTION trigger_regenerate_emi_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.emi_tenure != NEW.emi_tenure OR OLD.emi_amount != NEW.emi_amount OR 
     OLD.purchase_date != NEW.purchase_date OR OLD.emi_due_day != NEW.emi_due_day THEN
    PERFORM generate_emi_schedule(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS after_customer_update ON customers;
CREATE TRIGGER after_customer_update
  AFTER UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION trigger_regenerate_emi_on_update();

-- =============================================
-- RLS POLICIES
-- =============================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE retailers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE emi_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE fine_settings ENABLE ROW LEVEL SECURITY;

-- Helper function to get current user role
CREATE OR REPLACE FUNCTION get_my_role()
RETURNS TEXT AS $$
  SELECT role FROM profiles WHERE user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper function to get retailer id for current user
CREATE OR REPLACE FUNCTION get_my_retailer_id()
RETURNS UUID AS $$
  SELECT id FROM retailers WHERE auth_user_id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- PROFILES: users can read their own
CREATE POLICY "profiles_self" ON profiles FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "profiles_admin_all" ON profiles FOR ALL USING (get_my_role() = 'super_admin');

-- RETAILERS: admin full access, retailers can read own
CREATE POLICY "retailers_admin_all" ON retailers FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "retailers_self_read" ON retailers FOR SELECT USING (auth_user_id = auth.uid());

-- CUSTOMERS: admin all, retailer own
CREATE POLICY "customers_admin_all" ON customers FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "customers_retailer_own" ON customers FOR SELECT USING (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id()
);

-- EMI SCHEDULE: admin all, retailer via customer
CREATE POLICY "emi_admin_all" ON emi_schedule FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "emi_retailer_own" ON emi_schedule FOR SELECT USING (
  get_my_role() = 'retailer' AND 
  customer_id IN (SELECT id FROM customers WHERE retailer_id = get_my_retailer_id())
);

-- PAYMENT REQUESTS: admin all, retailer own
CREATE POLICY "payment_requests_admin_all" ON payment_requests FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "payment_requests_retailer_own" ON payment_requests FOR SELECT USING (
  get_my_role() = 'retailer' AND retailer_id = get_my_retailer_id()
);

-- PAYMENT REQUEST ITEMS: admin all, retailer via request
CREATE POLICY "payment_items_admin" ON payment_request_items FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "payment_items_retailer" ON payment_request_items FOR SELECT USING (
  get_my_role() = 'retailer' AND 
  payment_request_id IN (SELECT id FROM payment_requests WHERE retailer_id = get_my_retailer_id())
);

-- AUDIT LOG: admin read only (writes via service role)
CREATE POLICY "audit_admin_read" ON audit_log FOR SELECT USING (get_my_role() = 'super_admin');

-- FINE SETTINGS: admin all, retailer read
CREATE POLICY "fine_settings_admin" ON fine_settings FOR ALL USING (get_my_role() = 'super_admin');
CREATE POLICY "fine_settings_read" ON fine_settings FOR SELECT USING (auth.uid() IS NOT NULL);

-- =============================================
-- GRANT PERMISSIONS
-- =============================================
GRANT EXECUTE ON FUNCTION get_due_breakdown(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_role() TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_retailer_id() TO authenticated;
