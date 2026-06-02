'use client';

import { Customer, EMISchedule, DueBreakdown } from '@/lib/types';
import { calculateTotalFineFromEmis, getPerEmiFineBreakdown } from '@/lib/fineCalc';
import { formatCurrency, formatDateOnly } from '@/lib/formatters';
import { differenceInDays } from 'date-fns';

interface Props {
  customer: Customer;
  emis: EMISchedule[];
  breakdown?: DueBreakdown | null;
  baseFine?: number;
  weeklyIncrement?: number;
  /** When true, the "Loan Amount" tile is hidden (retailer view — super admin only). */
  hideLoanAmount?: boolean;
}

const fmt = formatCurrency;

export default function CustomerPaymentSummary({
  customer, emis, breakdown,
  baseFine = 450, weeklyIncrement = 25,
  hideLoanAmount = false,
}: Props) {
  // ── Core derivations ─────────────────────────────────────────────────────
  const purchaseValue = Number(customer.purchase_value || 0);
  const downPayment   = Number(customer.down_payment || 0);
  const loanAmount    = Math.max(0, purchaseValue - downPayment);

  const totalEmiCount = emis.length;
  const paidEmis      = emis.filter(e => e.status === 'APPROVED');
  const paidEmiCount  = paidEmis.length;

  // Money: EMI principal
  const totalEmiScheduled = emis.reduce((s, e) => s + Number(e.amount || 0), 0);
  const totalEmiPaid      = emis.reduce(
    (s, e) => s + Math.min(Number(e.amount || 0), Number(e.partial_paid_amount || 0)),
    0,
  );
  const totalEmiDue = Math.max(0, totalEmiScheduled - totalEmiPaid);

  // Money: Fines
  const fineBreakdown    = getPerEmiFineBreakdown(emis, baseFine, weeklyIncrement);
  const totalFinePaid    = emis.reduce((s, e) => s + Number(e.fine_paid_amount || 0), 0);
  const totalFineDue     = calculateTotalFineFromEmis(emis, baseFine, weeklyIncrement);

  // 1st EMI charge
  const firstCharge       = Number(customer.first_emi_charge_amount || 0);
  const firstChargePaid   = customer.first_emi_charge_paid_at ? firstCharge : 0;
  const firstChargeDue    = Math.max(0, firstCharge - firstChargePaid);

  // Aggregates
  const totalPaid      = totalEmiPaid + totalFinePaid + firstChargePaid;
  const totalRemaining = totalEmiDue + totalFineDue + firstChargeDue;

  // Next upcoming — prefer the unpaid EMI from the local list (always reflects
  // the latest state); breakdown is a fallback when present.
  const nextEmi = emis
    .filter(e => e.status === 'UNPAID' || e.status === 'PARTIALLY_PAID')
    .sort((a, b) => a.emi_no - b.emi_no)[0];
  const nextDueDate = nextEmi?.due_date ?? breakdown?.next_emi_due_date ?? null;
  const nextDaysLeft = nextDueDate
    ? differenceInDays(new Date(nextDueDate), new Date())
    : null;
  const nextEmiNo = nextEmi?.emi_no ?? breakdown?.next_emi_no ?? null;
  // Remaining principal on next EMI = scheduled − already-paid partial.
  const nextAmount = nextEmi
    ? Math.max(0, Number(nextEmi.amount || 0) - Number(nextEmi.partial_paid_amount || 0))
    : 0;
  const nextFine = nextEmi
    ? (fineBreakdown.find(r => r.emi_no === nextEmi.emi_no)?.remaining ?? 0)
    : 0;

  const overallProgress = totalEmiScheduled > 0
    ? Math.min(100, Math.round((totalEmiPaid / totalEmiScheduled) * 100))
    : 0;

  return (
    <div className="card overflow-hidden border-l-4 border-brand-500 shadow-md">
      {/* Header */}
      <div className="bg-gradient-to-r from-brand-600 via-amber-500 to-rose-500 text-white px-5 py-3 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-white/80">Payment Summary</p>
          <p className="text-sm font-bold mt-0.5">{customer.customer_name}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-white/80 uppercase">EMIs</p>
          <p className="num text-xl font-extrabold">{paidEmiCount}/{totalEmiCount}</p>
        </div>
      </div>

      {/* Loan & Aggregates row */}
      <div className={`grid grid-cols-2 ${hideLoanAmount ? 'md:grid-cols-3' : 'md:grid-cols-4'} gap-px bg-surface-4`}>
        {!hideLoanAmount && (
          <Tile
            tint="violet" emoji="💰" label="Loan Amount"
            value={fmt(loanAmount)}
            sub="Principal borrowed"
          />
        )}
        <Tile
          tint="emerald" emoji="✓" label="Total Paid"
          value={fmt(totalPaid)}
          sub="EMIs + Fines + Charges"
        />
        <Tile
          tint={totalRemaining > 0 ? 'rose' : 'emerald'}
          emoji={totalRemaining > 0 ? '⏳' : '✓'}
          label="Remaining Balance"
          value={fmt(totalRemaining)}
          sub={totalRemaining > 0 ? 'Outstanding total' : 'Fully cleared'}
        />
        <Tile
          tint="indigo" emoji="📱" label="Purchase Value"
          value={fmt(purchaseValue)}
          sub="Mobile price"
        />
      </div>

      {/* EMI / Fine trackers */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-px bg-surface-4">
        <Tracker
          title="💳 EMI Tracker"
          paidLabel="Total EMI Paid"
          paidValue={totalEmiPaid}
          dueLabel="Total EMI Due"
          dueValue={totalEmiDue}
          countLabel={`${paidEmiCount} of ${totalEmiCount} EMIs paid`}
          tint="emerald"
          dueTint={totalEmiDue > 0 ? 'rose' : 'emerald'}
        />
        <Tracker
          title="⚠️ Fine Tracker"
          paidLabel="Total Fine Paid"
          paidValue={totalFinePaid}
          dueLabel="Total Fine Due"
          dueValue={totalFineDue}
          countLabel={
            totalFineDue > 0
              ? `${fineBreakdown.length} EMI${fineBreakdown.length === 1 ? '' : 's'} carrying fine`
              : totalFinePaid > 0 ? 'All fines cleared' : 'No fines yet'
          }
          tint="emerald"
          dueTint={totalFineDue > 0 ? 'rose' : 'emerald'}
        />
      </div>

      {/* Progress bar */}
      <div className="px-5 py-3 bg-white">
        <div className="flex justify-between items-end mb-2">
          <p className="text-[11px] uppercase tracking-widest text-ink-muted font-semibold">Repayment Progress</p>
          <p className="num text-sm font-bold text-emerald-700">{overallProgress}%</p>
        </div>
        <div className="h-2.5 bg-surface-4 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700 bg-gradient-to-r from-emerald-500 via-amber-500 to-rose-500"
            style={{ width: `${overallProgress}%` }}
          />
        </div>
      </div>

      {/* Next upcoming EMI / Fine */}
      {nextEmiNo && nextDueDate ? (
        <NextStep
          emiNo={nextEmiNo}
          dueDate={nextDueDate}
          amount={nextAmount}
          fine={nextFine}
          daysLeft={nextDaysLeft}
          firstChargeDue={firstChargeDue}
        />
      ) : (
        <div className="px-5 py-4 bg-emerald-50 border-t border-emerald-200 flex items-center gap-3">
          <span className="text-2xl">🎉</span>
          <div>
            <p className="text-sm font-bold text-emerald-800">All EMIs Cleared</p>
            <p className="text-xs text-emerald-700">No upcoming installments due.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tile (single-metric card) ──────────────────────────────────────────────
function Tile({
  tint, emoji, label, value, sub,
}: { tint: 'indigo' | 'amber' | 'violet' | 'emerald' | 'sky' | 'rose'; emoji: string; label: string; value: string; sub?: string }) {
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

// ── Tracker (paid vs due in one cell) ─────────────────────────────────────
function Tracker({
  title, paidLabel, paidValue, dueLabel, dueValue, countLabel, tint, dueTint,
}: {
  title: string;
  paidLabel: string; paidValue: number;
  dueLabel: string; dueValue: number;
  countLabel: string;
  tint: 'emerald'; dueTint: 'emerald' | 'rose';
}) {
  return (
    <div className="bg-white p-4">
      <p className="text-[11px] uppercase tracking-widest text-ink-muted font-bold mb-2">{title}</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg px-3 py-2 bg-emerald-50 border border-emerald-200">
          <p className="text-[10px] text-emerald-700 uppercase font-semibold">{paidLabel}</p>
          <p className="num text-base font-bold text-emerald-800">{fmt(paidValue)}</p>
        </div>
        <div className={`rounded-lg px-3 py-2 border ${dueTint === 'rose' ? 'bg-rose-50 border-rose-200' : 'bg-emerald-50 border-emerald-200'}`}>
          <p className={`text-[10px] uppercase font-semibold ${dueTint === 'rose' ? 'text-rose-700' : 'text-emerald-700'}`}>{dueLabel}</p>
          <p className={`num text-base font-bold ${dueTint === 'rose' ? 'text-rose-800' : 'text-emerald-800'}`}>{fmt(dueValue)}</p>
        </div>
      </div>
      <p className="text-[10px] text-ink-muted mt-2">{countLabel}</p>
    </div>
  );
}

// ── Next actionable step ──────────────────────────────────────────────────
function NextStep({
  emiNo, dueDate, amount, fine, daysLeft, firstChargeDue,
}: {
  emiNo: number; dueDate: string; amount: number; fine: number;
  daysLeft: number | null; firstChargeDue: number;
}) {
  const overdue = daysLeft !== null && daysLeft < 0;
  const upcoming = daysLeft !== null && daysLeft >= 0;
  const total = amount + fine + firstChargeDue;

  return (
    <div className={`px-5 py-4 border-t-2 ${
      overdue ? 'border-rose-300 bg-gradient-to-r from-rose-50 to-rose-100'
              : upcoming && (daysLeft ?? 99) <= 5 ? 'border-amber-300 bg-gradient-to-r from-amber-50 to-amber-100'
              : 'border-sky-300 bg-gradient-to-r from-sky-50 to-sky-100'
    }`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className={`text-[10px] uppercase tracking-widest font-bold ${
            overdue ? 'text-rose-700' : upcoming && (daysLeft ?? 99) <= 5 ? 'text-amber-700' : 'text-sky-700'
          }`}>
            Next Upcoming
          </p>
          <p className="text-sm font-bold text-ink mt-0.5">
            EMI #{emiNo} · {formatDateOnly(dueDate)}
          </p>
          <p className={`text-xs mt-0.5 font-semibold ${
            overdue ? 'text-rose-700' : (daysLeft ?? 99) <= 5 ? 'text-amber-700' : 'text-ink-muted'
          }`}>
            {overdue && daysLeft !== null
              ? `⚠ Overdue by ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'}`
              : daysLeft === 0
                ? '⏰ Due today'
                : daysLeft !== null && daysLeft > 0
                  ? `🔔 In ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
                  : 'Pending'}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] uppercase tracking-wide text-ink-muted">Payable</p>
          <p className="num text-2xl font-extrabold text-brand-700">{fmt(total)}</p>
          <p className="text-[10px] text-ink-muted mt-0.5">
            {[
              amount > 0          ? `EMI ${fmt(amount)}`        : '',
              fine > 0            ? `Fine ${fmt(fine)}`         : '',
              firstChargeDue > 0  ? `Charge ${fmt(firstChargeDue)}` : '',
            ].filter(Boolean).join(' + ') || fmt(0)}
          </p>
        </div>
      </div>
    </div>
  );
}
