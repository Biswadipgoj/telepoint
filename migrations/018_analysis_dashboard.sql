-- ============================================================
-- 018 — ANALYSIS DASHBOARD (Year-over-Year intelligence)
-- ------------------------------------------------------------
-- Powers the admin "Analysis" tab. Provides one optimized RPC,
-- get_emi_analysis(p_month, p_year), that returns the current
-- month compared against the SAME month one year earlier, plus
-- the retailer leaderboards — all in a single round trip.
--
-- Schema note: the requested customers / emi_accounts / collections /
-- retailers model maps onto THIS project's existing tables as:
--   emi_accounts  -> emi_schedule        (per-installment rows)
--   collections   -> payment_requests    (one row per collection event)
-- Both customers and payment_requests already carry a retailer_id
-- foreign key, so the retailer leaderboards aggregate directly off the
-- indexed FK with no extra join tables required.
--
-- Run in: Supabase -> SQL Editor -> New query -> Run
-- ============================================================

-- ── Indexes that make the month-window scans fast ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_customers_purchase_date ON customers(purchase_date);
CREATE INDEX IF NOT EXISTS idx_customers_created_at     ON customers(created_at);
-- (idx_emi_due_date and idx_payment_req_approved_at already exist.)

-- ── Per-period metric helper ────────────────────────────────────────────────
-- Cohort dates: a customer is counted in the month their EMI plan started
-- (purchase_date, falling back to created_at). "invested" = phone inventory
-- cost financed that month. "collected" = every approved rupee received that
-- month. Bounce = installments due that month not yet fully APPROVED.
CREATE OR REPLACE FUNCTION _emi_period_metrics(p_month INT, p_year INT)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT jsonb_build_object(
    'invested', COALESCE((
      SELECT SUM(purchase_value) FROM customers
      WHERE EXTRACT(YEAR  FROM COALESCE(purchase_date, created_at::date)) = p_year
        AND EXTRACT(MONTH FROM COALESCE(purchase_date, created_at::date)) = p_month), 0),
    'customers', COALESCE((
      SELECT COUNT(*) FROM customers
      WHERE EXTRACT(YEAR  FROM COALESCE(purchase_date, created_at::date)) = p_year
        AND EXTRACT(MONTH FROM COALESCE(purchase_date, created_at::date)) = p_month), 0),
    'collected', COALESCE((
      SELECT SUM(total_amount) FROM payment_requests
      WHERE status = 'APPROVED' AND approved_at IS NOT NULL
        AND EXTRACT(YEAR  FROM approved_at) = p_year
        AND EXTRACT(MONTH FROM approved_at) = p_month), 0),
    'activeEmis', COALESCE((
      SELECT COUNT(*) FROM emi_schedule
      WHERE EXTRACT(YEAR  FROM due_date) = p_year
        AND EXTRACT(MONTH FROM due_date) = p_month), 0),
    'dueEmis', COALESCE((
      SELECT COUNT(*) FROM emi_schedule
      WHERE EXTRACT(YEAR  FROM due_date) = p_year
        AND EXTRACT(MONTH FROM due_date) = p_month), 0),
    'bouncedEmis', COALESCE((
      SELECT COUNT(*) FROM emi_schedule
      WHERE EXTRACT(YEAR  FROM due_date) = p_year
        AND EXTRACT(MONTH FROM due_date) = p_month
        AND status <> 'APPROVED'), 0)
  );
$$;

-- ── Main RPC consumed by components/AnalysisDashboard.tsx ────────────────────
CREATE OR REPLACE FUNCTION get_emi_analysis(p_month INT, p_year INT)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT jsonb_build_object(
    'thisYear', _emi_period_metrics(p_month, p_year),
    'lastYear', _emi_period_metrics(p_month, p_year - 1),

    -- Lead Generation Leaderboard: which retailer onboarded the most
    -- customers this month (current year).
    'leadLeaderboard', (
      SELECT COALESCE(
        jsonb_agg(jsonb_build_object('retailerId', id, 'name', name, 'value', cnt) ORDER BY cnt DESC),
        '[]'::jsonb)
      FROM (
        SELECT r.id, r.name, COUNT(c.id) AS cnt
        FROM retailers r
        JOIN customers c ON c.retailer_id = r.id
        WHERE EXTRACT(YEAR  FROM COALESCE(c.purchase_date, c.created_at::date)) = p_year
          AND EXTRACT(MONTH FROM COALESCE(c.purchase_date, c.created_at::date)) = p_month
        GROUP BY r.id, r.name
        ORDER BY cnt DESC
        LIMIT 5
      ) s
    ),

    -- Collection Leaderboard: which retailer collected the most EMI
    -- volume this month (current year).
    'collectionLeaderboard', (
      SELECT COALESCE(
        jsonb_agg(jsonb_build_object('retailerId', id, 'name', name, 'value', total) ORDER BY total DESC),
        '[]'::jsonb)
      FROM (
        SELECT r.id, r.name, SUM(pr.total_amount) AS total
        FROM retailers r
        JOIN payment_requests pr ON pr.retailer_id = r.id
        WHERE pr.status = 'APPROVED' AND pr.approved_at IS NOT NULL
          AND EXTRACT(YEAR  FROM pr.approved_at) = p_year
          AND EXTRACT(MONTH FROM pr.approved_at) = p_month
        GROUP BY r.id, r.name
        ORDER BY total DESC
        LIMIT 5
      ) s
    )
  );
$$;

-- ── Grants ───────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION _emi_period_metrics(INT, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_emi_analysis(INT, INT)    TO authenticated;

-- Example:
--   SELECT get_emi_analysis(6, 2026);   -- June 2026 vs June 2025
