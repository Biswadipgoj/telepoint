import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { calculateTotalFineFromEmis } from '@/lib/fineCalc';
import { fetchAllByIds, fetchAllPaged } from '@/lib/dbFetch';
import { EMISchedule } from '@/lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// Server-computed portfolio metrics.
//
// The Live DB dashboard and the per-retailer summary used to scan the WHOLE
// customers + emi_schedule tables from the browser. At MAMA TELECOM's scale
// (1000+ customers, many thousands of EMIs) that was both wrong (PostgREST's
// 1000-row cap truncated the read) and fragile (huge transfers / RLS / timeouts
// → the dashboard showed nothing). Here we do it once on the server with the
// service client (no RLS, no truncation — every row paged in) and return a tiny
// JSON the client just renders.
//
//   GET /api/metrics                 → whole-portfolio totals (admin only)
//   GET /api/metrics?retailer_id=…   → one retailer's totals
//
// Retailers are always scoped to themselves regardless of the query param.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

type CustomerRow = {
  id: string;
  status: string;
  purchase_value: number | null;
  down_payment: number | null;
  first_emi_charge_amount: number | null;
  first_emi_charge_paid_at: string | null;
};

export interface PortfolioMetrics {
  customerCount: number;
  runningCount: number;
  loanAmount: number;
  emiDue: number;
  fineDue: number;
  firstChargeDue: number;
  emiCollected: number;
  fineCollected: number;
  firstChargeCollected: number;
  upcoming30d: number;
  overdueCustomers: number;
}

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles').select('role').eq('user_id', user.id).single();
  const isAdmin = profile?.role === 'super_admin';
  const isRetailer = profile?.role === 'retailer';
  if (!isAdmin && !isRetailer) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const svc = createServiceClient();

  // ── Resolve scope ─────────────────────────────────────────────────────────
  let retailerId: string | null = req.nextUrl.searchParams.get('retailer_id');
  if (isRetailer) {
    // Retailers can only ever see their own portfolio.
    const { data: r } = await svc
      .from('retailers').select('id').eq('auth_user_id', user.id).single();
    if (!r) return NextResponse.json({ error: 'Retailer not found' }, { status: 403 });
    retailerId = r.id;
  }

  // ── Fine settings ─────────────────────────────────────────────────────────
  const { data: fs } = await svc
    .from('fine_settings').select('default_fine_amount, weekly_fine_increment').eq('id', 1).single();
  const baseFine = Number(fs?.default_fine_amount ?? 450);
  const weeklyIncrement = Number(fs?.weekly_fine_increment ?? 25);

  // ── Load customers (paged) ────────────────────────────────────────────────
  const customers = await fetchAllPaged<CustomerRow>((from, to) => {
    let q = svc
      .from('customers')
      .select('id, status, purchase_value, down_payment, first_emi_charge_amount, first_emi_charge_paid_at')
      .order('id')
      .range(from, to);
    if (retailerId) q = q.eq('retailer_id', retailerId);
    return q as unknown as PromiseLike<{ data: CustomerRow[] | null; error: { message: string } | null }>;
  });

  const empty: PortfolioMetrics = {
    customerCount: 0, runningCount: 0, loanAmount: 0, emiDue: 0, fineDue: 0,
    firstChargeDue: 0, emiCollected: 0, fineCollected: 0, firstChargeCollected: 0,
    upcoming30d: 0, overdueCustomers: 0,
  };
  if (!customers.length) return NextResponse.json(empty, { headers: { 'Cache-Control': 'no-store' } });

  // ── Load every EMI for those customers (chunked + paged) ──────────────────
  const ids = customers.map(c => c.id);
  const emiList = await fetchAllByIds<EMISchedule>(ids, (chunk, from, to) =>
    svc
      .from('emi_schedule')
      .select('id, customer_id, emi_no, due_date, amount, status, partial_paid_amount, fine_amount, fine_waived, fine_paid_amount')
      .in('customer_id', chunk)
      .order('customer_id')
      .order('emi_no')
      .range(from, to) as unknown as PromiseLike<{ data: EMISchedule[] | null; error: { message: string } | null }>,
  );

  const byCustomer = new Map<string, EMISchedule[]>();
  for (const e of emiList) {
    const arr = byCustomer.get(e.customer_id) ?? [];
    arr.push(e);
    byCustomer.set(e.customer_id, arr);
  }

  // ── Aggregate (same rules the dashboard + summary used) ───────────────────
  // An APPROVED EMI is fully paid even when partial_paid_amount was never
  // written (settlement / direct-approve set status only), so count its full
  // amount as collected.
  const emiPaid = (e: EMISchedule) =>
    e.status === 'APPROVED'
      ? Number(e.amount || 0)
      : Math.min(Number(e.amount || 0), Number(e.partial_paid_amount || 0));

  const todayMs = Date.now();
  const in30Ms = todayMs + 30 * 86_400_000;

  const m: PortfolioMetrics = { ...empty, customerCount: customers.length };

  for (const c of customers) {
    const cEmis = byCustomer.get(c.id) ?? [];
    const cFineDue = calculateTotalFineFromEmis(cEmis, baseFine, weeklyIncrement);
    const cEmiDue = cEmis.reduce((s, e) => s + Math.max(0, Number(e.amount || 0) - emiPaid(e)), 0);

    const chargeAmount = Number(c.first_emi_charge_amount || 0);
    const chargePaid = !!c.first_emi_charge_paid_at;
    const cFirstChargeDue = chargeAmount > 0 && !chargePaid ? chargeAmount : 0;
    const cFirstChargeCollected = chargeAmount > 0 && chargePaid ? chargeAmount : 0;

    // Scope: active loans + any finished loan still carrying an unpaid fine or
    // first-EMI charge. Fully-finished, fully-cleared loans drop out.
    const loanFinished = c.status !== 'RUNNING';
    const allCleared = cFineDue <= 0 && cFirstChargeDue <= 0;
    if (loanFinished && allCleared) continue;

    if (c.status === 'RUNNING') m.runningCount += 1;

    m.loanAmount += Math.max(0, Number(c.purchase_value || 0) - Number(c.down_payment || 0));
    m.emiDue += cEmiDue;
    m.fineDue += cFineDue;
    m.firstChargeDue += cFirstChargeDue;
    m.emiCollected += cEmis.reduce((s, e) => s + emiPaid(e), 0);
    m.fineCollected += cEmis.reduce((s, e) => s + Number(e.fine_paid_amount || 0), 0);
    m.firstChargeCollected += cFirstChargeCollected;

    let custOverdue = false;
    for (const e of cEmis) {
      if (e.status === 'APPROVED') continue;
      const due = new Date(e.due_date).getTime();
      if (due < todayMs) custOverdue = true;
      if (due >= todayMs && due <= in30Ms) {
        m.upcoming30d += Math.max(0, Number(e.amount || 0) - Number(e.partial_paid_amount || 0));
      }
    }
    if (custOverdue) m.overdueCustomers += 1;
  }

  return NextResponse.json(m, { headers: { 'Cache-Control': 'no-store' } });
}
