-- ============================================================
-- MIGRATION 006: Settlement + NPA support
-- Run in Supabase SQL Editor (idempotent)
-- ============================================================

-- 1. Add SETTLED to customer status CHECK constraint
-- Must drop and recreate the constraint
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_status_check;
ALTER TABLE customers ADD CONSTRAINT customers_status_check
  CHECK (status IN ('RUNNING', 'COMPLETE', 'SETTLED', 'NPA'));

-- 2. Add settlement columns
ALTER TABLE customers ADD COLUMN IF NOT EXISTS settlement_amount NUMERIC(12,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS settlement_date DATE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS settled_by UUID REFERENCES auth.users(id);

-- 3. Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';

DO $$ BEGIN
  RAISE NOTICE 'Migration 006 complete. SETTLED and NPA statuses added.';
END $$;
