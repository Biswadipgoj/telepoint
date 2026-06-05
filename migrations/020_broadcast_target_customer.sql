-- ============================================================
-- 020 — Direct retailer → customer broadcasts
-- ------------------------------------------------------------
-- Until now a broadcast targeted a whole retailer (target_retailer_id)
-- and every customer of that retailer saw it. This adds an optional
-- target_customer_id so a retailer can message ONE specific customer.
--
--   • target_customer_id IS NULL  → retailer-wide (existing behaviour).
--   • target_customer_id = <id>   → only that customer sees the popup.
--
-- target_retailer_id is still always set (the customer's retailer) so
-- existing scoping, cleanup and the retailer_read RLS policy keep working.
-- ============================================================

ALTER TABLE broadcast_messages
  ADD COLUMN IF NOT EXISTS target_customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_broadcast_customer ON broadcast_messages(target_customer_id);

COMMENT ON COLUMN broadcast_messages.target_customer_id IS
  'Optional. When set, the broadcast is delivered only to this customer '
  '(direct retailer → customer message). NULL = retailer-wide broadcast.';

DO $$
BEGIN
  RAISE NOTICE '020: broadcast_messages.target_customer_id added (direct customer broadcasts).';
END $$;
