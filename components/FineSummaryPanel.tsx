'use client';
import { EMISchedule } from '@/lib/types';
import { getPerEmiFineBreakdown } from '@/lib/fineCalc';
import { format } from 'date-fns';

function fmt(n: number) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(n); }

export default function FineSummaryPanel({ emis, onClose }: { emis: EMISchedule[]; onClose: () => void }) {
  const rows = getPerEmiFineBreakdown(emis);
  const totalRemaining = rows.reduce((s, r) => s + r.remaining, 0);
  const totalPaid = rows.reduce((s, r) => s + r.paid, 0);
  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel">
        <div className="sticky top-0 z-10 bg-white border-b border-surface-4 px-5 py-4 flex items-center justify-between">
          <h2 className="font-bold text-ink text-lg">⚠️ Fine Summary</h2>
          <button onClick={onClose} className="btn-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </div>
        <div className="p-5 space-y-4">
          {rows.length === 0 ? (
            <div className="text-center py-10"><p className="text-success font-semibold text-lg">✓ No Fine Due</p></div>
          ) : (<>
            <div className="card bg-danger-light border border-danger-border p-4 space-y-2">
              <div className="flex justify-between items-center">
                <span className="font-semibold text-danger">Total Fine Remaining</span>
                <span className="num text-2xl font-bold text-danger">{fmt(totalRemaining)}</span>
              </div>
              {totalPaid > 0 && <div className="flex justify-between text-sm"><span className="text-success">Total Paid</span><span className="num text-success font-medium">{fmt(totalPaid)}</span></div>}
            </div>
            {rows.map(r => {
              const emi = emis.find(e => e.emi_no === r.emi_no);
              return (
              <div key={r.emi_no} className="card bg-surface-2 p-4 space-y-2">
                <div className="flex justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink">EMI #{r.emi_no}</span>
                    {r.isLastEmi && <span className="text-[10px] bg-warning-light text-warning border border-warning-border px-1.5 py-0.5 rounded-full font-bold">LAST EMI</span>}
                  </div>
                  <span className="text-xs text-danger font-semibold bg-danger-light px-2 py-0.5 rounded-full border border-danger-border">{r.days}d overdue</span>
                </div>
                <div className="text-xs text-ink-muted">Due: {format(new Date(r.due_date), 'd MMM yyyy')} · Weekly starts: {format(new Date(r.graceEnds), 'd MMM yyyy')}</div>
                <div className="h-px bg-surface-4" />
                <div className="flex justify-between text-xs"><span className="text-ink-muted">Base Fine{r.isLastEmi ? ' (repeating)' : ''}</span><span className="num">{fmt(r.baseFineTotal)}</span></div>
                {r.weeklyFine > 0 && <div className="flex justify-between text-xs"><span className="text-ink-muted">Weekly ₹25</span><span className="num">{fmt(r.weeklyFine)}</span></div>}
                <div className="flex justify-between text-sm font-semibold"><span className="text-danger">Total Fine</span><span className="num text-danger">{fmt(r.totalFine)}</span></div>
                {r.paid > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-success">Paid{emi?.fine_paid_at ? ` on ${format(new Date(emi.fine_paid_at), 'd MMM yyyy')}` : ''}</span>
                    <span className="num text-success">-{fmt(r.paid)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm font-bold"><span className="text-danger">Remaining</span><span className="num text-danger">{fmt(r.remaining)}</span></div>
              </div>
            );})}
            <div className="card bg-surface-2 p-4 text-xs text-ink-muted space-y-1">
              <p className="font-bold uppercase tracking-widest mb-1">How Fine Works</p>
              <p>• ₹450 base fine when EMI becomes overdue</p>
              <p>• First 30 days: NO weekly — just ₹450</p>
              <p>• After 30 days: +₹25 every 7 days until fine is paid</p>
              <p>• EMI paid but fine not paid? Fine keeps growing</p>
              <p>• Last EMI: ₹450 repeats every 30 days, NO weekly charge</p>
            </div>
          </>)}
          <button onClick={onClose} className="btn-secondary w-full py-3">Close</button>
        </div>
      </div>
    </div>
  );
}
