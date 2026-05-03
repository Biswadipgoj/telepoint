-- ============================================================
-- EMI PORTAL — MIGRATION 005: Broadcast Messages
-- Run in Supabase SQL Editor
-- Safe to run multiple times (idempotent)
-- ============================================================

-- ── 1. Create broadcast_messages table ──────────────────────
CREATE TABLE IF NOT EXISTS broadcast_messages (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message            TEXT NOT NULL,
  image_url          TEXT,
  target_retailer_id UUID NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_by         UUID REFERENCES auth.users(id),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ── 2. Indexes ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_broadcast_retailer ON broadcast_messages(target_retailer_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_expires  ON broadcast_messages(expires_at);

-- ── 3. RLS ──────────────────────────────────────────────────
ALTER TABLE broadcast_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "broadcast_admin_all" ON broadcast_messages;
CREATE POLICY "broadcast_admin_all" ON broadcast_messages
  FOR ALL USING (get_my_role() = 'super_admin');

-- Retailers can read broadcasts targeting them
DROP POLICY IF EXISTS "broadcast_retailer_read" ON broadcast_messages;
CREATE POLICY "broadcast_retailer_read" ON broadcast_messages
  FOR SELECT USING (
    get_my_role() = 'retailer' AND target_retailer_id = get_my_retailer_id()
  );

-- ── 4. Reload schema cache ─────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ============================================================
-- DONE
-- ============================================================
DO $$
BEGIN
  RAISE NOTICE 'Migration 005 complete. broadcast_messages table created.';
END $$;
