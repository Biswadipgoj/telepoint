'use client';

/**
 * Consolidated payment summary for an entire retailer's portfolio.
 *
 * Shown:
 *   • Retailer page (own data) for the logged-in retailer.
 *   • Admin Retailers tab (any retailer drill-down) via the same component.
 *
 * Aggregates active loans + finished loans still carrying unpaid fines —
 * matching the same scope rule used by the Live DB Metric Dashboard so
 * the numbers are reconcilable across surfaces.
 */

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { calculateTotalFineFromEmis } from '@/lib/fineCalc';
import { fetchAllByIds, fetchAllPaged } from '@/lib/dbFetch';
import { EMISchedule } from '@/lib/types';
import { formatCurrency } from '@/lib/formatters';

type Customer = {
  id: string;
  status: string;
  purchase_value: number;
  down_payment: number;
  first_emi_charge_amount: number;
  first_emi_charge_paid_at?: string | null;
};

interface Props {
  retailerId: string;
  retailerName?: string;
  baseFine: number;
  weeklyIncrement: number;
  /** When true, the "Loan Book" tile is hidden (retailer view — super admin only). */
  hideLoanAmount?: boolean;
}

interface Totals {
  customerCount: number;
  runningCount: number;
  loanAmount: number;
  collected: number;
  emiDue: number;
  fineDue: number;
  fineCollected: number;
  firstChargeDue: number;
  firstChargeCollected: number;
  upcoming30d: number;
  overdueCustomers: number;
}

const fmt = formatCurrency;

export default function RetailerPaymentSummary({ retailerId, retailerName, baseFine, weeklyIncrement, hideLoanAmount = false }: Props) {
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const supabase = createClient();
    setLoading(true);
    try {
      // A big retailer (MAMA TELECOM has 1000+ customers and many thousands of
      // EMI rows) blows past PostgREST's ~1000-row cap and URL-length limit on a
      // naive `.in(customer_id, [...])`, so the totals were computed on a
      // truncated slice — wrong collected/due figures. Page + chunk every read.
      const customerList = await fetchAllPaged<Customer>((from, to) =>
        supabase
          .from('customers')
          .select('id, status, purchase_value, down_payment, first_emi_charge_amount, first_emi_charge_paid_at')
          .eq('retailer_id', retailerId)
          .order('id')
          .range(from, to),
      );
      if (!customerList.length) {
        setTotals({
          customerCount: 0, runningCount: 0, loanAmount: 0, collected: 0,
          emiDue: 0, fineDue: 0, fineCollected: 0, firstChargeDue: 0, firstChargeCollected: 0,
          upcoming30d: 0, overdueCustomers: 0,
        });
        return;
      }

      const ids = customerList.map(c => c.id);
      const emiList = await fetchAllByIds<EMISchedule>(ids, (chunk, from, to) =>
        supabase
          .from('emi_schedule')
          .select('id, customer_id, emi_no, due_date, amount, status, partial_paid_amount, fine_amount, fine_waived, fine_paid_amount')
          .in('customer_id', chunk)
          .order('customer_id')
          .order('emi_no')
          .range(from, to),
      );

      const byCustomer = new Map<string, EMISchedule[]>();
      for (const e of emiList) {
        const list = byCustomer.get(e.customer_id) ?? [];
        list.push(e);
        byCustomer.set(e.customer_id, list);
      }

      const todayMs = Date.now();
      const in30Ms = todayMs + 30 * 86_400_000;

      let loanAmount = 0, collected = 0, emiDue = 0, fineDue = 0, fineCollected = 0,
          firstChargeDue = 0, firstChargeCollected = 0, upcoming30d = 0, overdueCustomers = 0;
      let runningCount = 0;

      for (const c of customerList) {
        const cEmis = byCustomer.get(c.id) ?? [];
        const cFineDue = calculateTotalFineFromEmis(cEmis, baseFine, weeklyIncrement);
        // An APPROVED EMI is fully paid even if partial_paid_amount was never
        // written (settlement / direct-approve paths set status only), so count
        // its full amount as collected rather than leaving it perpetually due.
        const emiPaid = (e: EMISchedule) =>
          e.status === 'APPROVED'
            ? Number(e.amount || 0)
            : Math.min(Number(e.amount || 0), Number(e.partial_paid_amount || 0));
        const cEmiDue = cEmis.reduce(
          (s, e) => s + Math.max(0, Number(e.amount || 0) - emiPaid(e)),
          0,
        );
        const loanFinished = c.status !== 'RUNNING';
        const allFinesCleared = cFineDue <= 0;
        if (loanFinished && allFinesCleared) continue;

        if (c.status === 'RUNNING') runningCount += 1;

        loanAmount += Math.max(0, Number(c.purchase_value || 0) - Number(c.down_payment || 0));
        collected += cEmis.reduce((s, e) => s + emiPaid(e), 0);
        emiDue += cEmiDue;
        fineDue += cFineDue;
        fineCollected += cEmis.reduce((s, e) => s + Number(e.fine_paid_amount || 0), 0);

        // 1st EMI charge has both a due and a collected side; track both so it
        // is reflected in total collection once paid.
        const chargeAmount = Number(c.first_emi_charge_amount || 0);
        if (chargeAmount > 0) {
          if (c.first_emi_charge_paid_at) firstChargeCollected += chargeAmount;
          else firstChargeDue += chargeAmount;
        }

        let custOverdue = false;
        for (const e of cEmis) {
          if (e.status === 'APPROVED') continue;
          const due = new Date(e.due_date).getTime();
          if (due < todayMs) custOverdue = true;
          if (due >= todayMs && due <= in30Ms) {
            upcoming30d += Math.max(0, Number(e.amount || 0) - Number(e.partial_paid_amount || 0));
          }
        }
        if (custOverdue) overdueCustomers += 1;
      }

      setTotals({
        customerCount: customerList.length,
        runningCount,
        loanAmount,
        collected,
        emiDue,
        fineDue,
        fineCollected,
        firstChargeDue,
        firstChargeCollected,
        upcoming30d,
        overdueCustomers,
      });
    } finally {
      setLoading(false);
    }
  }, [retailerId, baseFine, weeklyIncrement]);

  useEffect(() => { load(); }, [load]);

  const t = totals ?? {
    customerCount: 0, runningCount: 0, loanAmount: 0, collected: 0,
    emiDue: 0, fineDue: 0, fineCollected: 0, firstChargeDue: 0, firstChargeCollected: 0,
    upcoming30d: 0, overdueCustomers: 0,
  };
  const totalRevenueExpected =
    t.loanAmount + t.fineDue + t.fineCollected + t.firstChargeDue + t.firstChargeCollected;
  const totalRevenueCollected = t.collected + t.fineCollected + t.firstChargeCollected;
  const collectionPct = totalRevenueExpected > 0
    ? Math.min(100, Math.round((totalRevenueCollected / totalRevenueExpected) * 100))
    : 0;

  return (
    <div className="card overflow-hidden border-l-4 border-brand-500 shadow-md">
      <div className="bg-gradient-to-r from-brand-600 via-amber-500 to-rose-500 text-white px-5 py-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/80">Retailer Collection Summary</p>
          <p className="text-sm font-bold mt-0.5">{retailerName || 'My Portfolio'}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-white/80 uppercase">Active Loans</p>
          <p className="num text-xl font-extrabold">{t.runningCount}/{t.customerCount}</p>
        </div>
        <button onClick={load} className="text-[10px] underline underline-offset-2 ml-3">
          {loading ? '…' : '↻'}
        </button>
      </div>

      <div className={`grid grid-cols-2 ${hideLoanAmount ? 'md:grid-cols-3' : 'md:grid-cols-4'} gap-px bg-surface-4`}>
        {!hideLoanAmount && (
          <Tile tint="violet" emoji="💰" label="Loan Book" value={fmt(t.loanAmount)} sub="Total disbursed (active)" />
        )}
        <Tile tint="emerald" emoji="✓" label="Collected" value={fmt(totalRevenueCollected)} sub="EMI + Fines + 1st Charge" />
        <Tile tint={t.emiDue > 0 ? 'rose' : 'emerald'} emoji="⏳" label="EMI Due" value={fmt(t.emiDue)} sub={`${t.overdueCustomers} customer${t.overdueCustomers === 1 ? '' : 's'} overdue`} />
        <Tile tint={t.fineDue > 0 ? 'rose' : 'emerald'} emoji="⚠" label="Fine Due" value={fmt(t.fineDue)} sub={`Paid ${fmt(t.fineCollected)} so far`} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-surface-4">
        <Tile tint="amber" emoji="⭐" label="1st Charge Due" value={fmt(t.firstChargeDue)} sub="Pending one-time charge" />
        <Tile tint="indigo" emoji="📅" label="Next 30 Days" value={fmt(t.upcoming30d)} sub="Upcoming collections" />
        <Tile tint="sky" emoji="📊" label="Collection %" value={`${collectionPct}%`} sub="Revenue captured" />
      </div>

      <div className="px-5 py-3 bg-white">
        <div className="flex justify-between items-end mb-2">
          <p className="text-[11px] uppercase tracking-widest text-ink-muted font-semibold">Portfolio Health</p>
          <p className="num text-sm font-bold text-emerald-700">{collectionPct}%</p>
        </div>
        <div className="h-2.5 bg-surface-4 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700 bg-gradient-to-r from-emerald-500 via-amber-500 to-rose-500"
            style={{ width: `${collectionPct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function Tile({ tint, emoji, label, value, sub }: {
  tint: 'indigo' | 'amber' | 'violet' | 'emerald' | 'sky' | 'rose';
  emoji: string; label: string; value: string; sub?: string;
}) {
  const bg: Record<string, string> = {
    indigo: 'bg-indigo-50', amber: 'bg-amber-50', violet: 'bg-violet-50',
    emerald: 'bg-emerald-50', sky: 'bg-sky-50', rose: 'bg-rose-50',
  };
  const label$: Record<string, string> = {
    indigo: 'text-indigo-700', amber: 'text-amber-700', violet: 'text-violet-700',
    emerald: 'text-emerald-700', sky: 'text-sky-700', rose: 'text-rose-700',
  };
  const value$: Record<string, string> = {
    indigo: 'text-indigo-900', amber: 'text-amber-900', violet: 'text-violet-900',
    emerald: 'text-emerald-900', sky: 'text-sky-900', rose: 'text-rose-900',
  };
  return (
    <div className={`${bg[tint]} px-4 py-3`}>
      <p className={`text-[10px] ${label$[tint]} uppercase tracking-wide font-bold flex items-center gap-1`}>
        <span>{emoji}</span> {label}
      </p>
      <p className={`num font-bold text-lg ${value$[tint]} mt-1`}>{value}</p>
      {sub && <p className={`text-[10px] ${label$[tint]} opacity-80 mt-0.5`}>{sub}</p>}
    </div>
  );
}
