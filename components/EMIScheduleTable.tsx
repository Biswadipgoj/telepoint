'use client';

import { useState, useRef} from 'react';
import { EMISchedule } from '@/lib/types';
import { format, differenceInDays, addDays } from 'date-fns';
import { createClient } from '@/lib/supabase/client';
import toast from 'react-hot-toast';
import { calculateSingleEmiFine } from '@/lib/fineCalc';
import { formatCurrency } from '@/lib/formatters';

interface Props {
  emis: EMISchedule[];
  isAdmin?: boolean;
  nextUnpaidNo?: number;
  onRefresh?: () => void;
  defaultFineAmount?: number;
}

const fmt = formatCurrency;

export default function EMIScheduleTable({ emis, isAdmin, nextUnpaidNo, onRefresh, defaultFineAmount = 450 }: Props) {
  const _sbRef = useRef<ReturnType<typeof createClient> | null>(null);
  if (typeof window !== 'undefined' && !_sbRef.current) _sbRef.current = createClient();
  const supabase = _sbRef.current!;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fineOverride, setFineOverride] = useState('');
  const [dateOverride, setDateOverride] = useState('');
  const [saving, setSaving] = useState(false);

  const sortedEmis = [...emis].sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
  const paidCount  = sortedEmis.filter(e => e.status === 'APPROVED').length;
  const maxEmiNo   = sortedEmis.length > 0 ? Math.max(...sortedEmis.map(e => e.emi_no)) : 0;

  // ── saveEdit: properly awaited update with null guards ───────────────────
  async function saveEdit(emi: EMISchedule) {
    // Guard: supabase client must be available (requires browser environment)
    if (!supabase) {
      toast.error('Client not initialised — please refresh the page');
      return;
    }

    const updates: Record<string, unknown> = {};
    if (fineOverride.trim() !== '') {
      const parsed = parseFloat(fineOverride);
      if (isNaN(parsed) || parsed < 0) { toast.error('Invalid fine amount'); return; }
      updates.fine_amount = parsed;
    }
    if (dateOverride.trim() !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) { toast.error('Invalid date format'); return; }
      updates.due_date = dateOverride;
    }

    if (Object.keys(updates).length === 0) {
      toast('Nothing changed.', { icon: 'ℹ️' });
      setEditingId(null);
      return;
    }

    setSaving(true);
    try {
      // .select().single() forces PostgREST to execute and return the updated row.
      // Without .select(), the update is fire-and-forget and errors can be silently ignored.
      const { data: updated, error } = await supabase
        .from('emi_schedule')
        .update(updates)
        .eq('id', emi.id)
        .select()
        .single();

      if (error) {
        console.error('EMI update error:', error);
        toast.error('Save failed: ' + error.message);
        return;
      }

      if (!updated) {
        toast.error('Update returned no data — possible RLS issue');
        return;
      }

      toast.success('EMI updated ✓');
      setEditingId(null);
      setFineOverride('');
      setDateOverride('');
      // Refresh parent AFTER state is cleared so it gets the latest row
      onRefresh?.();
    } catch (err) {
      console.error('EMI update exception:', err);
      toast.error('Unexpected error: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-surface-4 bg-surface-2">
        <p className="text-xs font-bold text-ink-muted uppercase tracking-widest">EMI Schedule</p>
        <div className="flex gap-2 text-xs">
          <span className="badge-green">{paidCount} paid</span>
          <span className="badge-gray">{sortedEmis.length} total</span>
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Due Date</th>
              <th>Amount</th>
              <th>Fine (Outstanding)</th>
              <th>Status</th>
              <th>Paid On</th>
              <th>Mode</th>
              {isAdmin && <th className="text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {sortedEmis.map(emi => {
              const today     = new Date();
              const dueDate   = new Date(emi.due_date);
              const isOverdue = ['UNPAID', 'PARTIALLY_PAID'].includes(emi.status) && dueDate < today;
              const isNext    = emi.emi_no === nextUnpaidNo;
              const isLastEmi = emi.emi_no === maxEmiNo;
              const editing   = editingId === emi.id;

              const autoFine      = isOverdue ? calculateSingleEmiFine(emi.due_date, isLastEmi, defaultFineAmount) : 0;
              const totalFine     = Math.max(autoFine, emi.fine_amount || 0);
              const finePaid      = Number(emi.fine_paid_amount || 0);
              // ── KEY FIX: show OUTSTANDING fine (remaining), not total accrued
              const fineOutstanding = Math.max(0, totalFine - finePaid);

              const emiPaid      = Math.max(0, Number(emi.partial_paid_amount || 0));
              const emiRemaining = Math.max(0, Number(emi.amount || 0) - emiPaid);
              const overdueDays  = isOverdue ? differenceInDays(today, dueDate) : 0;
              const fineStartDate = addDays(dueDate, 1);

              return (
                <tr key={emi.id} className={isOverdue ? 'bg-danger-light/30' : isNext ? 'bg-brand-50/50' : ''}>
                  <td className="font-semibold text-ink">
                    #{emi.emi_no}
                    {isNext && (
                      <span className="ml-1 text-[9px] bg-success-light text-success border border-success-border px-1 py-0.5 rounded-full">
                        NEXT
                      </span>
                    )}
                  </td>

                  <td>
                    {editing ? (
                      <input type="date" value={dateOverride || emi.due_date}
                        onChange={e => setDateOverride(e.target.value)}
                        className="input py-1 px-2 text-xs w-36" />
                    ) : (
                      <div>
                        <span className={`num text-sm ${isOverdue ? 'text-danger font-medium' : ''}`}>
                          {format(dueDate, 'd MMM yyyy')}
                          {isOverdue && ' ⚠'}
                        </span>
                        {isOverdue && (
                          <p className="text-[10px] text-danger mt-0.5">
                            Overdue by {overdueDays}d
                          </p>
                        )}
                      </div>
                    )}
                  </td>

                  <td className="num font-medium">
                    <div>{fmt(emi.amount)}</div>
                    {emi.status === 'PARTIALLY_PAID' && (
                      <div className="text-[10px] text-warning mt-0.5">Remaining: {fmt(emiRemaining)}</div>
                    )}
                  </td>

                  {/* Fine column — always shows OUTSTANDING balance */}
                  <td>
                    {editing ? (
                      <input type="number" value={fineOverride}
                        onChange={e => setFineOverride(e.target.value)}
                        placeholder={String(emi.fine_amount || 0)}
                        className="input py-1 px-2 text-xs w-24" />
                    ) : fineOutstanding > 0 ? (
                      <div>
                        <span className="num text-xs font-semibold text-danger">{fmt(fineOutstanding)}</span>
                        {finePaid > 0 && (
                          <p className="text-[10px] text-success mt-0.5">
                            Paid: {fmt(finePaid)}
                            {emi.fine_paid_at && ` (${format(new Date(emi.fine_paid_at), 'd MMM')})`}
                          </p>
                        )}
                        {isOverdue && (
                          <p className="text-[10px] text-danger/70 mt-0.5">
                            From {format(fineStartDate, 'd MMM')}
                          </p>
                        )}
                      </div>
                    ) : totalFine > 0 && finePaid >= totalFine ? (
                      <span className="badge-green text-[10px]">Fine Cleared</span>
                    ) : (
                      <span className="text-ink-muted text-xs">—</span>
                    )}
                  </td>

                  <td>
                    {emi.status === 'APPROVED'          && <span className="badge-blue">✓ Paid</span>}
                    {emi.status === 'PARTIALLY_PAID'    && <span className="badge-yellow">Partial</span>}
                    {emi.status === 'PENDING_APPROVAL'  && <span className="badge-yellow">⏳ Pending</span>}
                    {emi.status === 'UNPAID' && (
                      <span className={`badge ${isOverdue ? 'badge-red' : 'badge-gray'}`}>
                        {isOverdue ? 'Overdue' : 'Unpaid'}
                      </span>
                    )}
                  </td>

                  <td className="num text-xs text-ink-muted">
                    {emi.paid_at
                      ? format(new Date(emi.paid_at), 'd MMM yy')
                      : emi.partial_paid_at
                      ? `${format(new Date(emi.partial_paid_at), 'd MMM yy')} (partial)`
                      : '—'}
                  </td>

                  <td className="text-xs text-ink-muted">{emi.utr ? `UTR ${emi.utr}` : emi.mode || '—'}</td>

                  {isAdmin && (
                    <td className="text-right">
                      {editing ? (
                        <div className="flex items-center gap-1 justify-end">
                          <button onClick={() => saveEdit(emi)} disabled={saving}
                            className="btn-success text-xs px-2 py-1 min-h-0">
                            {saving ? '…' : 'Save'}
                          </button>
                          <button onClick={() => { setEditingId(null); setFineOverride(''); setDateOverride(''); }}
                            className="btn-secondary text-xs px-2 py-1 min-h-0">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingId(emi.id); setFineOverride(''); setDateOverride(''); }}
                          className="btn-ghost text-xs px-2 py-1 min-h-0"
                          title="Edit EMI">
                          ✏
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden divide-y divide-surface-3">
        {sortedEmis.map(emi => {
          const today      = new Date();
          const dueDate    = new Date(emi.due_date);
          const isOverdue  = ['UNPAID', 'PARTIALLY_PAID'].includes(emi.status) && dueDate < today;
          const isNext     = emi.emi_no === nextUnpaidNo;
          const isLastEmi  = emi.emi_no === maxEmiNo;
          const autoFine   = isOverdue ? calculateSingleEmiFine(emi.due_date, isLastEmi, defaultFineAmount) : 0;
          const totalFine  = Math.max(autoFine, emi.fine_amount || 0);
          const finePaid   = Number(emi.fine_paid_amount || 0);
          const fineOutstanding = Math.max(0, totalFine - finePaid);
          const emiPaid    = Math.max(0, Number(emi.partial_paid_amount || 0));
          const emiRemaining = Math.max(0, Number(emi.amount || 0) - emiPaid);

          return (
            <div key={emi.id} className={`p-4 space-y-2 ${isOverdue ? 'bg-danger-light/40' : isNext ? 'bg-brand-50/50' : ''}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-ink">EMI #{emi.emi_no}</p>
                  {isNext && <span className="text-[9px] bg-success-light text-success border border-success-border px-1.5 py-0.5 rounded-full">NEXT</span>}
                </div>
                {emi.status === 'APPROVED'         && <span className="badge-blue">✓ Paid</span>}
                {emi.status === 'PARTIALLY_PAID'   && <span className="badge-yellow">Partial</span>}
                {emi.status === 'PENDING_APPROVAL' && <span className="badge-yellow">⏳ Pending</span>}
                {emi.status === 'UNPAID' && (
                  <span className={`badge ${isOverdue ? 'badge-red' : 'badge-gray'}`}>
                    {isOverdue ? 'Overdue' : 'Unpaid'}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <p className="text-ink-muted">Due Date</p>
                <p className={`text-right num ${isOverdue ? 'text-danger font-medium' : ''}`}>
                  {format(dueDate, 'd MMM yyyy')}
                </p>
                <p className="text-ink-muted">EMI Amount</p>
                <p className="text-right num">{fmt(emi.amount)}</p>
                {emi.status === 'PARTIALLY_PAID' && (
                  <>
                    <p className="text-ink-muted">EMI Paid</p>
                    <p className="text-right num text-success">{fmt(emiPaid)}</p>
                    <p className="text-ink-muted">EMI Left</p>
                    <p className="text-right num text-warning">{fmt(emiRemaining)}</p>
                  </>
                )}
                <p className="text-ink-muted">Fine Due</p>
                <p className={`text-right num ${fineOutstanding > 0 ? 'text-danger font-semibold' : 'text-ink-muted'}`}>
                  {fineOutstanding > 0 ? fmt(fineOutstanding) : '—'}
                </p>
                {finePaid > 0 && (
                  <>
                    <p className="text-ink-muted">Fine Paid</p>
                    <p className="text-right num text-success">{fmt(finePaid)}</p>
                  </>
                )}
                <p className="text-ink-muted">Paid On</p>
                <p className="text-right num">
                  {emi.paid_at
                    ? format(new Date(emi.paid_at), 'd MMM yy')
                    : emi.partial_paid_at
                    ? `${format(new Date(emi.partial_paid_at), 'd MMM yy')} (partial)`
                    : '—'}
                </p>
                {emi.utr && (
                  <>
                    <p className="text-ink-muted">UTR</p>
                    <p className="text-right font-mono text-[10px]">{emi.utr}</p>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
