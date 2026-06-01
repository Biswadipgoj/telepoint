'use client';

import { useState, useRef } from 'react';
import { EMISchedule } from '@/lib/types';
import { format, differenceInDays, addDays } from 'date-fns';
import { createClient } from '@/lib/supabase/client';
import toast from 'react-hot-toast';
import { calculateSingleEmiFine } from '@/lib/fineCalc';
import { formatCurrency, toDateTimeLocalInput, fromDateTimeLocalInput } from '@/lib/formatters';

interface Props {
  emis: EMISchedule[];
  isAdmin?: boolean;
  nextUnpaidNo?: number;
  onRefresh?: () => void;
  defaultFineAmount?: number;
  weeklyIncrement?: number;
}

const fmt = formatCurrency;

// Human-friendly date/time for paid timestamps
function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return format(d, 'd MMM yyyy, h:mm a');
  } catch { return '—'; }
}

type EditableStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'APPROVED' | 'PENDING_APPROVAL';
type FineState = 'UNPAID' | 'PAID' | 'WAIVED';
type PayMode = '' | 'CASH' | 'UPI';
type EditState = {
  fine: string;
  date: string;
  status: EditableStatus;
  initialStatus: EditableStatus;  // dropdown value at edit-open; used to detect real changes
  partial: string;
  finePaid: string;
  utr: string;
  mode: PayMode;
  paidAt: string;       // datetime-local IST string
  finePaidAt: string;   // datetime-local IST string
  fineState: FineState;
  fineMode: PayMode;
};

export default function EMIScheduleTable({
  emis, isAdmin, nextUnpaidNo, onRefresh,
  defaultFineAmount = 450, weeklyIncrement = 25,
}: Props) {
  const _sbRef = useRef<ReturnType<typeof createClient> | null>(null);
  if (typeof window !== 'undefined' && !_sbRef.current) _sbRef.current = createClient();
  const supabase = _sbRef.current!;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>({
    fine: '', date: '', status: 'UNPAID', initialStatus: 'UNPAID', partial: '', finePaid: '',
    utr: '', mode: '', paidAt: '', finePaidAt: '', fineState: 'UNPAID', fineMode: '',
  });
  const [saving, setSaving] = useState(false);

  const sortedEmis = [...emis].sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
  const paidCount  = sortedEmis.filter(e => e.status === 'APPROVED').length;
  const maxEmiNo   = sortedEmis.length > 0 ? Math.max(...sortedEmis.map(e => e.emi_no)) : 0;

  function beginEdit(emi: EMISchedule) {
    const startStatus: EditableStatus = emi.status as EditableStatus;
    const fineStored = Number(emi.fine_amount || 0);
    const finePaidNum = Number(emi.fine_paid_amount || 0);
    const startFineState: FineState = emi.fine_waived
      ? 'WAIVED'
      : (fineStored > 0 && finePaidNum >= fineStored ? 'PAID' : 'UNPAID');
    setEditingId(emi.id);
    setEdit({
      fine: '',
      date: '',
      status: startStatus,
      initialStatus: startStatus,
      partial: String(emi.partial_paid_amount ?? ''),
      finePaid: String(emi.fine_paid_amount ?? ''),
      utr: emi.utr || '',
      mode: (emi.mode as PayMode) || '',
      paidAt: toDateTimeLocalInput(emi.paid_at || emi.partial_paid_at),
      finePaidAt: toDateTimeLocalInput(emi.fine_paid_at),
      fineState: startFineState,
      fineMode: '',
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEdit({
      fine: '', date: '', status: 'UNPAID', initialStatus: 'UNPAID', partial: '', finePaid: '',
      utr: '', mode: '', paidAt: '', finePaidAt: '', fineState: 'UNPAID', fineMode: '',
    });
  }

  // ── Admin full override save ─────────────────────────────────────────────
  async function saveEdit(emi: EMISchedule) {
    if (!supabase) {
      toast.error('Client not initialised — please refresh the page');
      return;
    }

    const updates: Record<string, unknown> = {};
    const now = new Date().toISOString();

    // Fine override
    if (edit.fine.trim() !== '') {
      const parsed = parseFloat(edit.fine);
      if (isNaN(parsed) || parsed < 0) { toast.error('Invalid fine amount'); return; }
      updates.fine_amount = parsed;
    }

    // Due-date override
    if (edit.date.trim() !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(edit.date)) { toast.error('Invalid date format'); return; }
      updates.due_date = edit.date;
    }

    // Fine paid override (super admin)
    if (edit.finePaid.trim() !== '' && Number(edit.finePaid) !== Number(emi.fine_paid_amount || 0)) {
      const parsed = parseFloat(edit.finePaid);
      if (isNaN(parsed) || parsed < 0) { toast.error('Invalid fine paid'); return; }
      updates.fine_paid_amount = parsed;
      updates.fine_paid_at = parsed > 0 ? (emi.fine_paid_at ?? now) : null;
    }

    // Status / partial override (super admin)
    const partialNum = edit.partial.trim() === '' ? Number(emi.partial_paid_amount || 0) : parseFloat(edit.partial);
    if (isNaN(partialNum) || partialNum < 0) { toast.error('Invalid paid amount'); return; }
    const emiAmount = Number(emi.amount || 0);
    if (partialNum > emiAmount) { toast.error('Paid amount cannot exceed EMI amount'); return; }

    let nextStatus = edit.status;
    let nextPartial = partialNum;
    if (nextStatus === 'APPROVED') {
      nextPartial = emiAmount;
    } else if (nextStatus === 'UNPAID' || nextStatus === 'PENDING_APPROVAL') {
      if (nextStatus === 'UNPAID') nextPartial = 0;
    } else if (nextStatus === 'PARTIALLY_PAID') {
      // Default to half-EMI when admin flips status but didn't enter an amount.
      if (edit.partial.trim() === '' || nextPartial <= 0) {
        nextPartial = Math.max(1, Math.round(emiAmount / 2));
      }
      if (nextPartial >= emiAmount) {
        toast.error('For partial, paid amount must be less than the EMI amount. Use "Paid" status for full payment.');
        return;
      }
    }

    // Only write status if admin actually changed the dropdown from its
    // opening value (avoids silently flipping PENDING_APPROVAL → UNPAID).
    const statusChanged  = nextStatus !== edit.initialStatus;
    const partialChanged = nextPartial !== Number(emi.partial_paid_amount || 0);
    if (statusChanged || partialChanged) {
      updates.status = nextStatus;
      updates.partial_paid_amount = nextPartial;
      updates.partial_paid_at = nextPartial > 0 ? (emi.partial_paid_at ?? now) : null;
      updates.paid_at = nextStatus === 'APPROVED' ? (emi.paid_at ?? now) : null;
      if (nextStatus === 'UNPAID') {
        updates.mode = null;
        updates.utr  = null;
        updates.approved_by = null;
      }
    }

    // Payment mode + UTR override
    if (edit.mode !== '' && edit.mode !== (emi.mode || '')) {
      updates.mode = edit.mode;
    }
    if (edit.utr.trim() !== (emi.utr || '')) {
      updates.utr = edit.utr.trim() || null;
    }

    // Payment timestamp override (paid_time)
    if (edit.paidAt && edit.paidAt !== toDateTimeLocalInput(emi.paid_at || emi.partial_paid_at)) {
      const iso = fromDateTimeLocalInput(edit.paidAt);
      if (iso) {
        updates.paid_at = iso;
        if (!updates.partial_paid_at) updates.partial_paid_at = iso;
      }
    }

    // Fine state (PAID / UNPAID / WAIVED)
    const initialFineState: FineState = emi.fine_waived
      ? 'WAIVED'
      : (Number(emi.fine_amount || 0) > 0 && Number(emi.fine_paid_amount || 0) >= Number(emi.fine_amount || 0) ? 'PAID' : 'UNPAID');
    if (edit.fineState !== initialFineState) {
      if (edit.fineState === 'WAIVED') {
        updates.fine_waived = true;
        updates.fine_paid_amount = 0;
        updates.fine_paid_at = null;
      } else if (edit.fineState === 'PAID') {
        updates.fine_waived = false;
        const stored = updates.fine_amount !== undefined ? Number(updates.fine_amount) : Number(emi.fine_amount || 0);
        if (stored > 0) {
          updates.fine_paid_amount = stored;
          updates.fine_paid_at = emi.fine_paid_at ?? now;
        }
      } else {
        // UNPAID
        updates.fine_waived = false;
        updates.fine_paid_amount = 0;
        updates.fine_paid_at = null;
      }
    }

    // Fine timestamp override
    if (edit.finePaidAt && edit.finePaidAt !== toDateTimeLocalInput(emi.fine_paid_at)) {
      const iso = fromDateTimeLocalInput(edit.finePaidAt);
      if (iso) updates.fine_paid_at = iso;
    }

    if (Object.keys(updates).length === 0) {
      toast('Nothing changed.', { icon: 'ℹ️' });
      cancelEdit();
      return;
    }

    setSaving(true);
    try {
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
      cancelEdit();
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
      <div className="flex items-center justify-between px-5 py-3 border-b border-surface-4 bg-gradient-to-r from-emerald-50 via-amber-50 to-rose-50">
        <p className="text-xs font-bold text-ink uppercase tracking-widest">EMI Schedule</p>
        <div className="flex gap-2 text-xs">
          <span className="badge bg-emerald-100 text-emerald-800 border border-emerald-300">{paidCount} paid</span>
          <span className="badge bg-slate-100 text-slate-700 border border-slate-300">{sortedEmis.length} total</span>
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>Due Date</th>
              <th>EMI Amount</th>
              <th>Fine</th>
              <th>Status</th>
              <th>Paid On (Date & Time)</th>
              {isAdmin && <th className="text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {sortedEmis.map(emi => {
              const today         = new Date();
              const dueDate       = new Date(emi.due_date);
              const isOverdue     = ['UNPAID', 'PARTIALLY_PAID'].includes(emi.status) && dueDate < today;
              const isNext        = emi.emi_no === nextUnpaidNo;
              const isLastEmi     = emi.emi_no === maxEmiNo;
              const isLastEmiUnpaid = isLastEmi && emi.status !== 'APPROVED';
              const editing       = editingId === emi.id;

              const autoFine        = isOverdue
                ? calculateSingleEmiFine(emi.due_date, isLastEmiUnpaid, defaultFineAmount, weeklyIncrement)
                : 0;
              const totalFine       = Math.max(autoFine, Number(emi.fine_amount || 0));
              const finePaid        = Number(emi.fine_paid_amount || 0);
              const fineOutstanding = Math.max(0, totalFine - finePaid);
              const emiPaid         = Math.max(0, Number(emi.partial_paid_amount || 0));
              const emiAmount       = Number(emi.amount || 0);
              const emiRemaining    = Math.max(0, emiAmount - emiPaid);
              const overdueDays     = isOverdue ? differenceInDays(today, dueDate) : 0;
              const fineStartDate   = addDays(dueDate, 1);

              const rowBg =
                emi.status === 'APPROVED'        ? 'bg-emerald-50/50'  :
                emi.status === 'PARTIALLY_PAID'  ? 'bg-amber-50/60'    :
                isOverdue                        ? 'bg-rose-50/60'     :
                isNext                           ? 'bg-brand-50/60'    : '';

              const rowAccent =
                emi.status === 'APPROVED'        ? 'border-l-4 border-l-emerald-500' :
                emi.status === 'PARTIALLY_PAID'  ? 'border-l-4 border-l-amber-500'   :
                isOverdue                        ? 'border-l-4 border-l-rose-500'    :
                isNext                           ? 'border-l-4 border-l-brand-500'   : 'border-l-4 border-l-slate-200';

              return (
                <tr key={emi.id} className={`${rowBg} border-b-2 border-b-slate-100`}>
                  <td className={`font-semibold text-ink ${rowAccent}`}>
                    #{emi.emi_no}
                    {isNext && (
                      <span className="ml-1 text-[9px] bg-emerald-100 text-emerald-800 border border-emerald-300 px-1 py-0.5 rounded-full">NEXT</span>
                    )}
                    {isLastEmi && (
                      <span className="ml-1 text-[9px] bg-amber-100 text-amber-800 border border-amber-300 px-1 py-0.5 rounded-full">LAST</span>
                    )}
                  </td>

                  {/* Due Date */}
                  <td>
                    {editing ? (
                      <input
                        type="date"
                        value={edit.date || emi.due_date}
                        onChange={e => setEdit(s => ({ ...s, date: e.target.value }))}
                        className="input py-1 px-2 text-xs w-36"
                      />
                    ) : (
                      <div>
                        <span className={`num text-sm ${isOverdue ? 'text-rose-700 font-semibold' : 'text-ink'}`}>
                          {format(dueDate, 'd MMM yyyy')}
                        </span>
                        {isOverdue && (
                          <p className="text-[10px] text-rose-700 mt-0.5">Overdue by {overdueDays}d</p>
                        )}
                      </div>
                    )}
                  </td>

                  {/* EMI Amount + partial outstanding */}
                  <td>
                    {editing ? (
                      <input
                        type="number"
                        min={0}
                        max={emiAmount}
                        value={edit.partial}
                        onChange={e => setEdit(s => ({ ...s, partial: e.target.value }))}
                        placeholder={`Paid (0–${emiAmount})`}
                        className="input py-1 px-2 text-xs w-32"
                      />
                    ) : (
                      <div>
                        <div className="num font-semibold text-ink">{fmt(emiAmount)}</div>
                        {emi.status === 'PARTIALLY_PAID' && emiRemaining > 0 && (
                          <div className="text-[10px] text-amber-700 mt-0.5 font-semibold">
                            ✓ Paid {fmt(emiPaid)} · ⚠ Outstanding {fmt(emiRemaining)}
                          </div>
                        )}
                        {emi.status === 'APPROVED' && (
                          <div className="text-[10px] text-emerald-700 mt-0.5 font-semibold">✓ Fully paid</div>
                        )}
                      </div>
                    )}
                  </td>

                  {/* Fine column — paid vs remaining + start date */}
                  <td>
                    {editing ? (
                      <div className="space-y-1">
                        <input
                          type="number"
                          value={edit.fine}
                          onChange={e => setEdit(s => ({ ...s, fine: e.target.value }))}
                          placeholder={`Fine (${Number(emi.fine_amount || 0)})`}
                          className="input py-1 px-2 text-xs w-32"
                          min={0}
                        />
                        <input
                          type="number"
                          value={edit.finePaid}
                          onChange={e => setEdit(s => ({ ...s, finePaid: e.target.value }))}
                          placeholder={`Fine paid (${finePaid})`}
                          className="input py-1 px-2 text-xs w-32"
                          min={0}
                        />
                      </div>
                    ) : fineOutstanding > 0 ? (
                      <div className="space-y-0.5">
                        <span className="num text-xs font-bold text-rose-800 bg-rose-100 border border-rose-300 px-2 py-0.5 rounded-md">
                          Due {fmt(fineOutstanding)}
                        </span>
                        {finePaid > 0 && (
                          <p className="text-[10px] text-emerald-700 font-semibold">
                            ✓ Paid {fmt(finePaid)}{emi.fine_paid_at && ` · ${fmtDateTime(emi.fine_paid_at)}`}
                          </p>
                        )}
                        {isOverdue && (
                          <p className="text-[10px] text-rose-600/80">From {format(fineStartDate, 'd MMM')}</p>
                        )}
                      </div>
                    ) : totalFine > 0 && finePaid >= totalFine ? (
                      <div className="space-y-0.5">
                        <span className="badge bg-emerald-100 text-emerald-800 border border-emerald-300 text-[10px]">
                          ✓ Fine Cleared
                        </span>
                        <p className="text-[10px] text-emerald-700 font-semibold">
                          {fmt(finePaid)}{emi.fine_paid_at && ` · ${fmtDateTime(emi.fine_paid_at)}`}
                        </p>
                      </div>
                    ) : (
                      <span className="text-xs text-ink-muted">—</span>
                    )}
                  </td>

                  {/* Status */}
                  <td>
                    {editing && isAdmin ? (
                      <select
                        value={edit.status}
                        onChange={e => setEdit(s => ({ ...s, status: e.target.value as EditableStatus }))}
                        className="input py-1 px-2 text-xs"
                      >
                        <option value="APPROVED">PAID</option>
                        <option value="PARTIALLY_PAID">PARTIAL</option>
                        <option value="PENDING_APPROVAL">PENDING</option>
                        <option value="UNPAID">UNPAID / OVERDUE</option>
                      </select>
                    ) : (
                      <StatusBadge emi={emi} isOverdue={isOverdue} />
                    )}
                  </td>

                  {/* Paid On (with separate fine paid timestamp) */}
                  <td className="text-xs">
                    {emi.paid_at ? (
                      <p className="num font-semibold text-emerald-800">{fmtDateTime(emi.paid_at)}</p>
                    ) : emi.partial_paid_at ? (
                      <p className="num font-semibold text-amber-800">{fmtDateTime(emi.partial_paid_at)} <span className="font-normal">(partial)</span></p>
                    ) : (
                      <p className="text-ink-muted">—</p>
                    )}
                    {emi.utr && (
                      <p className="font-mono text-[10px] text-ink-muted mt-0.5">UTR {emi.utr}</p>
                    )}
                    {emi.fine_paid_at && finePaid > 0 && (
                      <p className="text-[10px] text-rose-700 mt-0.5">
                        Fine paid: <span className="num">{fmtDateTime(emi.fine_paid_at)}</span>
                      </p>
                    )}
                  </td>

                  {isAdmin && (
                    <td className="text-right">
                      {editing ? (
                        <div className="flex items-center gap-1 justify-end">
                          <button onClick={() => saveEdit(emi)} disabled={saving}
                            className="btn-success text-xs px-2 py-1 min-h-0">
                            {saving ? '…' : 'Save'}
                          </button>
                          <button onClick={cancelEdit} className="btn-secondary text-xs px-2 py-1 min-h-0">
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 justify-end flex-wrap">
                          <button onClick={() => beginEdit(emi)}
                            className="btn-ghost text-xs px-2 py-1 min-h-0" title="Open Edit panel to change status / record payment">
                            ✏ Edit
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {/* Inline edit panel — desktop. Rendered separately so it spans all columns. */}
          </tbody>
        </table>
        {editingId && isAdmin && (() => {
          const emi = sortedEmis.find(x => x.id === editingId);
          if (!emi) return null;
          return (
            <div className="px-5 py-4 bg-slate-50 border-t border-surface-4">
              <p className="text-[11px] uppercase tracking-widest font-bold text-ink-muted mb-3">
                ⚙ Super Admin Override · EMI #{emi.emi_no}
              </p>
              <div className="grid grid-cols-3 gap-3 text-xs">
                <label className="block">
                  <span className="text-ink-muted">EMI Status</span>
                  <select
                    value={edit.status}
                    onChange={e => setEdit(s => ({ ...s, status: e.target.value as EditableStatus }))}
                    className="input py-1 px-2 text-xs mt-0.5 w-full"
                  >
                    <option value="APPROVED">PAID</option>
                    <option value="PARTIALLY_PAID">PARTIALLY PAID</option>
                    <option value="PENDING_APPROVAL">PENDING</option>
                    <option value="UNPAID">UNPAID (OVERDUE if past due)</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-ink-muted">Payment Mode</span>
                  <select
                    value={edit.mode}
                    onChange={e => setEdit(s => ({ ...s, mode: e.target.value as PayMode }))}
                    className="input py-1 px-2 text-xs mt-0.5 w-full"
                  >
                    <option value="">— unchanged —</option>
                    <option value="CASH">CASH</option>
                    <option value="UPI">UPI</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-ink-muted">UTR Number</span>
                  <input
                    type="text"
                    value={edit.utr}
                    onChange={e => setEdit(s => ({ ...s, utr: e.target.value }))}
                    placeholder={emi.utr || '— none —'}
                    className="input py-1 px-2 text-xs mt-0.5 w-full"
                  />
                </label>
                <label className="block">
                  <span className="text-ink-muted">Payment Timestamp (paid_time)</span>
                  <input
                    type="datetime-local"
                    value={edit.paidAt}
                    onChange={e => setEdit(s => ({ ...s, paidAt: e.target.value }))}
                    className="input py-1 px-2 text-xs mt-0.5 w-full"
                  />
                </label>
                <label className="block">
                  <span className="text-ink-muted">Fine State</span>
                  <select
                    value={edit.fineState}
                    onChange={e => setEdit(s => ({ ...s, fineState: e.target.value as FineState }))}
                    className="input py-1 px-2 text-xs mt-0.5 w-full"
                  >
                    <option value="PAID">PAID</option>
                    <option value="UNPAID">UNPAID</option>
                    <option value="WAIVED">WAIVED</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-ink-muted">Fine Payment Timestamp</span>
                  <input
                    type="datetime-local"
                    value={edit.finePaidAt}
                    onChange={e => setEdit(s => ({ ...s, finePaidAt: e.target.value }))}
                    className="input py-1 px-2 text-xs mt-0.5 w-full"
                  />
                </label>
              </div>
              <p className="text-[10px] text-ink-muted mt-3">
                Atomic write: pressing Save commits all overrides directly to the EMI row.
              </p>
            </div>
          );
        })()}
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-4 p-3">
        {sortedEmis.map(emi => {
          const today      = new Date();
          const dueDate    = new Date(emi.due_date);
          const isOverdue  = ['UNPAID', 'PARTIALLY_PAID'].includes(emi.status) && dueDate < today;
          const isNext     = emi.emi_no === nextUnpaidNo;
          const isLastEmi  = emi.emi_no === maxEmiNo;
          const isLastEmiUnpaid = isLastEmi && emi.status !== 'APPROVED';
          const autoFine   = isOverdue
            ? calculateSingleEmiFine(emi.due_date, isLastEmiUnpaid, defaultFineAmount, weeklyIncrement)
            : 0;
          const totalFine  = Math.max(autoFine, Number(emi.fine_amount || 0));
          const finePaid   = Number(emi.fine_paid_amount || 0);
          const fineOutstanding = Math.max(0, totalFine - finePaid);
          const emiAmount       = Number(emi.amount || 0);
          const emiPaid    = Math.max(0, Number(emi.partial_paid_amount || 0));
          const emiRemaining = Math.max(0, emiAmount - emiPaid);

          return (
            /* Outer box — border color is a direct Tailwind literal per status */
            <div
              key={emi.id}
              style={{ boxShadow: '0 2px 10px rgba(0,0,0,0.10)' }}
              className={
                emi.status === 'APPROVED'        ? 'rounded-2xl border-2 border-emerald-400 overflow-hidden' :
                emi.status === 'PARTIALLY_PAID'  ? 'rounded-2xl border-2 border-amber-400 overflow-hidden'   :
                isOverdue                        ? 'rounded-2xl border-2 border-rose-400 overflow-hidden'    :
                isNext                           ? 'rounded-2xl border-2 border-brand-400 overflow-hidden'   :
                                                   'rounded-2xl border-2 border-slate-300 overflow-hidden'
              }
            >
              {/* Colored header — full solid background per status */}
              <div className={
                emi.status === 'APPROVED'        ? 'bg-emerald-600 px-4 py-3 flex items-center justify-between gap-2' :
                emi.status === 'PARTIALLY_PAID'  ? 'bg-amber-500 px-4 py-3 flex items-center justify-between gap-2'   :
                isOverdue                        ? 'bg-rose-600 px-4 py-3 flex items-center justify-between gap-2'    :
                isNext                           ? 'bg-brand-600 px-4 py-3 flex items-center justify-between gap-2'   :
                                                   'bg-slate-500 px-4 py-3 flex items-center justify-between gap-2'
              }>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-white">EMI #{emi.emi_no}</span>
                  {isNext && <span className="text-[9px] bg-white/25 text-white border border-white/40 px-1.5 py-0.5 rounded-full font-bold">NEXT</span>}
                  {isLastEmi && <span className="text-[9px] bg-white/25 text-white border border-white/40 px-1.5 py-0.5 rounded-full font-bold">LAST</span>}
                </div>
                <span className="text-[10px] font-bold text-white bg-white/20 border border-white/30 px-2 py-0.5 rounded-full whitespace-nowrap">
                  {emi.status === 'APPROVED'        ? '✓ PAID'     :
                   emi.status === 'PARTIALLY_PAID'  ? '◐ PARTIAL'  :
                   emi.status === 'PENDING_APPROVAL'? '⏳ PENDING' :
                   isOverdue                        ? '⚠ OVERDUE'  : 'UNPAID'}
                </span>
              </div>

              {/* White card body */}
              <div className="bg-white px-4 py-3 space-y-3">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <p className="text-ink-muted">Due Date</p>
                  <p className={`text-right num font-semibold ${isOverdue ? 'text-rose-700' : 'text-ink'}`}>
                    {format(dueDate, 'd MMM yyyy')}
                  </p>
                  <p className="text-ink-muted">EMI Amount</p>
                  <p className="text-right num font-semibold text-ink">{fmt(emiAmount)}</p>

                  {emi.status === 'PARTIALLY_PAID' && (
                    <>
                      <p className="text-ink-muted">EMI Paid</p>
                      <p className="text-right num font-bold text-emerald-700">{fmt(emiPaid)}</p>
                      <p className="text-ink-muted">Outstanding</p>
                      <p className="text-right num font-bold text-amber-700">{fmt(emiRemaining)}</p>
                    </>
                  )}

                  <p className="text-ink-muted">Fine Due</p>
                  <p className={`text-right num font-bold ${fineOutstanding > 0 ? 'text-rose-700' : 'text-ink-muted'}`}>
                    {fineOutstanding > 0 ? fmt(fineOutstanding) : '—'}
                  </p>

                  {finePaid > 0 && (
                    <>
                      <p className="text-ink-muted">Fine Paid</p>
                      <p className="text-right num font-bold text-emerald-700">{fmt(finePaid)}</p>
                    </>
                  )}

                  {(emi.paid_at || emi.partial_paid_at) && (
                    <>
                      <p className="text-ink-muted">Paid On</p>
                      <p className="text-right num text-[11px] text-emerald-800 font-semibold">
                        {fmtDateTime(emi.paid_at || emi.partial_paid_at)}
                      </p>
                    </>
                  )}

                  {emi.fine_paid_at && finePaid > 0 && (
                    <>
                      <p className="text-ink-muted">Fine Paid On</p>
                      <p className="text-right num text-[11px] text-rose-700 font-semibold">
                        {fmtDateTime(emi.fine_paid_at)}
                      </p>
                    </>
                  )}

                  {emi.utr && (
                    <>
                      <p className="text-ink-muted">UTR</p>
                      <p className="text-right font-mono text-[10px]">{emi.utr}</p>
                    </>
                  )}
                </div>

                {/* Admin edit button */}
                {isAdmin && editingId !== emi.id && (
                  <div className="pt-2 border-t border-slate-100">
                    <button onClick={() => beginEdit(emi)}
                      className="text-[11px] px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200 transition font-medium">
                      ✏ Edit
                    </button>
                  </div>
                )}

              {/* Inline mobile edit form — Super Admin override panel */}
              {isAdmin && editingId === emi.id && (
                <div className="mt-2 p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2">
                  <p className="text-[10px] uppercase tracking-widest font-bold text-ink-muted">
                    ⚙ Super Admin Override
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-[11px]">
                    <label className="block">
                      <span className="text-ink-muted">EMI Status</span>
                      <select
                        value={edit.status}
                        onChange={e => setEdit(s => ({ ...s, status: e.target.value as EditableStatus }))}
                        className="input py-1 px-2 text-xs mt-0.5 w-full"
                      >
                        <option value="APPROVED">PAID</option>
                        <option value="PARTIALLY_PAID">PARTIAL</option>
                        <option value="PENDING_APPROVAL">PENDING</option>
                        <option value="UNPAID">UNPAID / OVERDUE</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-ink-muted">Amount Paid</span>
                      <input
                        type="number" min={0} max={emiAmount}
                        value={edit.partial}
                        onChange={e => setEdit(s => ({ ...s, partial: e.target.value }))}
                        placeholder={`0–${emiAmount}`}
                        className="input py-1 px-2 text-xs mt-0.5 w-full"
                      />
                    </label>
                    <label className="block">
                      <span className="text-ink-muted">Due date</span>
                      <input
                        type="date"
                        value={edit.date || emi.due_date}
                        onChange={e => setEdit(s => ({ ...s, date: e.target.value }))}
                        className="input py-1 px-2 text-xs mt-0.5 w-full"
                      />
                    </label>
                    <label className="block">
                      <span className="text-ink-muted">Payment Mode</span>
                      <select
                        value={edit.mode}
                        onChange={e => setEdit(s => ({ ...s, mode: e.target.value as PayMode }))}
                        className="input py-1 px-2 text-xs mt-0.5 w-full"
                      >
                        <option value="">— unchanged —</option>
                        <option value="CASH">CASH</option>
                        <option value="UPI">UPI</option>
                      </select>
                    </label>
                    <label className="block col-span-2">
                      <span className="text-ink-muted">UTR Number</span>
                      <input
                        type="text"
                        value={edit.utr}
                        onChange={e => setEdit(s => ({ ...s, utr: e.target.value }))}
                        placeholder={emi.utr || '— none —'}
                        className="input py-1 px-2 text-xs mt-0.5 w-full"
                      />
                    </label>
                    <label className="block col-span-2">
                      <span className="text-ink-muted">Payment Timestamp (paid_time)</span>
                      <input
                        type="datetime-local"
                        value={edit.paidAt}
                        onChange={e => setEdit(s => ({ ...s, paidAt: e.target.value }))}
                        className="input py-1 px-2 text-xs mt-0.5 w-full"
                      />
                    </label>
                    <label className="block">
                      <span className="text-ink-muted">Fine Amount</span>
                      <input
                        type="number" min={0}
                        value={edit.fine}
                        onChange={e => setEdit(s => ({ ...s, fine: e.target.value }))}
                        placeholder={String(emi.fine_amount || 0)}
                        className="input py-1 px-2 text-xs mt-0.5 w-full"
                      />
                    </label>
                    <label className="block">
                      <span className="text-ink-muted">Fine State</span>
                      <select
                        value={edit.fineState}
                        onChange={e => setEdit(s => ({ ...s, fineState: e.target.value as FineState }))}
                        className="input py-1 px-2 text-xs mt-0.5 w-full"
                      >
                        <option value="PAID">PAID</option>
                        <option value="UNPAID">UNPAID</option>
                        <option value="WAIVED">WAIVED</option>
                      </select>
                    </label>
                    <label className="block col-span-2">
                      <span className="text-ink-muted">Fine already paid</span>
                      <input
                        type="number" min={0}
                        value={edit.finePaid}
                        onChange={e => setEdit(s => ({ ...s, finePaid: e.target.value }))}
                        placeholder={String(finePaid)}
                        className="input py-1 px-2 text-xs mt-0.5 w-full"
                      />
                    </label>
                    <label className="block col-span-2">
                      <span className="text-ink-muted">Fine Payment Timestamp</span>
                      <input
                        type="datetime-local"
                        value={edit.finePaidAt}
                        onChange={e => setEdit(s => ({ ...s, finePaidAt: e.target.value }))}
                        className="input py-1 px-2 text-xs mt-0.5 w-full"
                      />
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => saveEdit(emi)} disabled={saving}
                      className="btn-success flex-1 text-xs py-1 min-h-0">
                      {saving ? 'Saving…' : '💾 Save'}
                    </button>
                    <button onClick={cancelEdit} className="btn-secondary flex-1 text-xs py-1 min-h-0">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────
function StatusBadge({ emi, isOverdue }: { emi: EMISchedule; isOverdue: boolean }) {
  if (emi.status === 'APPROVED') {
    return <span className="badge bg-emerald-100 text-emerald-800 border border-emerald-300 font-bold whitespace-nowrap">✓ EMI PAID</span>;
  }
  if (emi.status === 'PARTIALLY_PAID') {
    return <span className="badge bg-amber-100 text-amber-800 border border-amber-300 font-bold whitespace-nowrap">◐ EMI PARTIALLY PAID</span>;
  }
  if (emi.status === 'PENDING_APPROVAL') {
    return <span className="badge bg-sky-100 text-sky-800 border border-sky-300 font-bold whitespace-nowrap">⏳ Pending Approval</span>;
  }
  // UNPAID
  return isOverdue
    ? <span className="badge bg-rose-100 text-rose-800 border border-rose-300 font-bold whitespace-nowrap">⚠ OVERDUE</span>
    : <span className="badge bg-slate-100 text-slate-700 border border-slate-300 font-semibold whitespace-nowrap">UNPAID</span>;
}
