'use client';

import { DueBreakdown } from '@/lib/types';
import { format, addDays, differenceInDays } from 'date-fns';
import { memo } from 'react';

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(n);
}

const DueBreakdownPanel = memo(function DueBreakdownPanel({ breakdown }: { breakdown: DueBreakdown }) {
  if (!breakdown || !breakdown.next_emi_no) return null;

  const dueDate = breakdown.next_emi_due_date ? new Date(breakdown.next_emi_due_date) : null;
  const fineStartDate = dueDate ? addDays(dueDate, 1) : null;
  const overdueDays = dueDate && breakdown.is_overdue
    ? differenceInDays(new Date(), dueDate)
    : 0;

  return (
    <div className="card overflow-hidden border-l-4 border-brand-500 bg-gradient-to-br from-brand-50 via-white to-white shadow-md">
      <div className="px-5 py-3 bg-gradient-to-r from-brand-500 to-amber-500 text-white">
        <p className="text-[11px] font-bold uppercase tracking-widest">Next Payment Due</p>
      </div>
      <div className="p-5 space-y-2.5">
        {(breakdown.selected_emi_amount ?? breakdown.next_emi_amount ?? 0) > 0 && (
          <Row
            label={`💳 EMI #${breakdown.next_emi_no}`}
            value={fmt(breakdown.selected_emi_amount ?? breakdown.next_emi_amount ?? 0)}
            tint="emerald"
          />
        )}
        {breakdown.first_emi_charge_due > 0 && (
          <Row label="⭐ 1st EMI Charge" value={fmt(breakdown.first_emi_charge_due)} tint="amber" />
        )}
        {breakdown.fine_due > 0 ? (
          <div className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2">
            <Row label="⚠️ Late Fine" value={fmt(breakdown.fine_due)} tint="rose" />
            {fineStartDate && (
              <p className="text-[11px] text-rose-700 mt-0.5">
                Fine from: {format(fineStartDate, 'd MMM yyyy')}
              </p>
            )}
          </div>
        ) : (
          <Row label="✓ Late Fine" value={fmt(0)} tint="emerald" />
        )}
        <div className="h-px bg-surface-4 my-1" />
        <div className="flex justify-between items-center rounded-xl px-3 py-2 bg-gradient-to-r from-brand-100 to-amber-100 border border-brand-300">
          <span className="font-bold text-ink text-base">Total Payable</span>
          <span className="num font-bold text-2xl text-brand-700">{fmt(breakdown.total_payable)}</span>
        </div>
        {dueDate && (
          <div className="space-y-0.5">
            <p className={`text-xs font-semibold ${breakdown.is_overdue ? 'text-rose-700' : 'text-ink-muted'}`}>
              Due: {format(dueDate, 'd MMMM yyyy')}
              {breakdown.is_overdue && ` — OVERDUE`}
            </p>
            {overdueDays > 0 && (
              <p className="text-xs text-rose-700 font-semibold">
                Overdue by {overdueDays} day{overdueDays !== 1 ? 's' : ''}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default DueBreakdownPanel;

function Row({ label, value, tint }: { label: string; value: string; tint: 'emerald' | 'amber' | 'rose' | 'sky' | 'ink' }) {
  const labelCls: Record<string, string> = {
    emerald: 'text-emerald-700', amber: 'text-amber-700', rose: 'text-rose-700', sky: 'text-sky-700', ink: 'text-ink-muted',
  };
  const valueCls: Record<string, string> = {
    emerald: 'text-emerald-800', amber: 'text-amber-800', rose: 'text-rose-800', sky: 'text-sky-800', ink: 'text-ink',
  };
  return (
    <div className="flex justify-between text-sm">
      <span className={`font-semibold ${labelCls[tint]}`}>{label}</span>
      <span className={`num font-bold ${valueCls[tint]}`}>{value}</span>
    </div>
  );
}
