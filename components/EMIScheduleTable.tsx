'use client';

import { useState, useRef, useMemo, memo } from 'react';
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

// Render currency — ensures ₹0 displays cleanly (not as a struck-through 0)
function fmt(value: unknown): string {
  const num = Number(value ?? 0);
  if (!Number.isFinite(num) || num === 0) return '₹0'; // ₹0 via unicode to avoid font glyph issues
  const formatted = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(num).replace(/\s+/g, '');
  return formatted && formatted.length > 0 ? formatted : '₹0';
}

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

  const sortedEmis = useMemo(() => [...emis].sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime()), [emis]);
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

  const totalEmis = sortedEmis.length;

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

      {/* One clearly-separated box per EMI — same layout on mobile & desktop.
          Each EMI sits inside its own bordered, shadowed card so installments
          are never visually run together. */}
      <div className="bg-surface-2 p-3 sm:p-4 flex flex-col gap-4">
        {sortedEmis.map((emi) => {
          const today           = new Date();
          const dueDate         = new Date(emi.due_date);
          const isOverdue       = ['UNPAID', 'PARTIALLY_PAID'].includes(emi.status) && dueDate < today;
          const isNext          = emi.emi_no === nextUnpaidNo;
          const isLastEmi       = emi.emi_no === maxEmiNo;
          const isLastEmiUnpaid = isLastEmi && emi.status !== 'APPROVED';
          const editing         = editingId === emi.id;

          const autoFine        = isOverdue
            ? calculateSingleEmiFine(emi.due_date, isLastEmiUnpaid, defaultFineAmount, weeklyIncrement)
            : 0;
          const totalFine       = Math.max(autoFine, Number(emi.fine_amount || 0));
          const finePaid        = Number(emi.fine_paid_amount || 0);
          const fineOutstanding = Math.max(0, totalFine - finePaid);
          const emiAmount       = Number(emi.amount || 0);
          const emiPaid         = Math.max(0, Number(emi.partial_paid_amount || 0));
          const emiRemaining    = Math.max(0, emiAmount - emiPaid);
          const overdueDays     = isOverdue ? differenceInDays(today, dueDate) : 0;
          const fineStartDate   = addDays(dueDate, 1);

          // Payment method must always show for a paid EMI. The `mode` column is
          // null on older / imported rows, so derive it: a UTR means it was UPI,
          // otherwise a settled EMI was Cash.
          const emiHasPayment = emi.status === 'APPROVED' || emi.status === 'PARTIALLY_PAID'
            || !!emi.paid_at || !!emi.partial_paid_at;
          const payMethod: '' | 'CASH' | 'UPI' =
            (emi.mode as 'CASH' | 'UPI' | undefined) || (emi.utr ? 'UPI' : (emiHasPayment ? 'CASH' : ''));

          // Status-driven colours — inline styles so they survive CSS purge.
          const statusColor =
            emi.status === 'APPROVED'       ? { border: '#22c55e', header: '#16a34a' } :
            emi.status === 'PARTIALLY_PAID' ? { border: '#f59e0b', header: '#d97706' } :
            isOverdue                       ? { border: '#f87171', header: '#dc2626' } :
            isNext                          ? { border: '#ca8a04', header: '#a16207' } :
                                              { border: '#94a3b8', header: '#64748b' };

          const statusLabel =
            emi.status === 'APPROVED'         ? '✓ PAID'    :
            emi.status === 'PARTIALLY_PAID'   ? '◐ PARTIAL' :
            emi.status === 'PENDING_APPROVAL' ? '⏳ PENDING' :
            isOverdue                         ? '⚠ OVERDUE' : 'UNPAID';

          return (
            <div
              key={emi.id}
              className="rounded-2xl overflow-hidden bg-white"
              style={{
                border: `2.5px solid ${statusColor.border}`,
                boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
              }}
            >
              {/* Colored header bar — installment number is large & unmistakable */}
              <div
                className="px-4 py-3 flex items-center justify-between gap-2"
                style={{ backgroundColor: statusColor.header }}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex flex-col leading-tight">
                    <span className="font-extrabold text-white text-lg">EMI {emi.emi_no}</span>
                    <span className="text-[10px] text-white/80 font-medium">of {totalEmis} installments</span>
                  </div>
                  {isNext && <span className="text-[9px] bg-white/25 text-white border border-white/40 px-1.5 py-0.5 rounded-full font-bold">NEXT</span>}
                  {isLastEmi && <span className="text-[9px] bg-white/25 text-white border border-white/40 px-1.5 py-0.5 rounded-full font-bold">LAST</span>}
                </div>
                <span className="text-[11px] font-bold text-white bg-white/20 border border-white/30 px-2.5 py-0.5 rounded-full whitespace-nowrap">
                  {statusLabel}
                </span>
              </div>

              {/* Card body — responsive grid of labelled cells */}
              <div className="px-4 py-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {/* Due Date */}
                  <div className="rounded-xl border border-surface-4 bg-surface-2 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-ink-muted font-bold">Due Date</p>
                    {editing ? (
                      <input
                        type="date"
                        value={edit.date || emi.due_date}
                        onChange={e => setEdit(s => ({ ...s, date: e.target.value }))}
                        className="input py-1 px-2 text-xs w-full mt-1"
                      />
                    ) : (
                      <>
                        <p className={`num text-sm font-bold mt-0.5 ${isOverdue ? 'text-rose-700' : 'text-ink'}`}>
                          {format(dueDate, 'd MMM yyyy')}
                        </p>
                        {isOverdue && (
                          <p className="text-[10px] text-rose-700 mt-0.5 font-semibold">⚠ Overdue by {overdueDays}d</p>
                        )}
                      </>
                    )}
                  </div>

                  {/* EMI Amount */}
                  <div className="rounded-xl border border-surface-4 bg-surface-2 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-ink-muted font-bold">EMI Amount</p>
                    {editing ? (
                      <input
                        type="number"
                        min={0}
                        max={emiAmount}
                        value={edit.partial}
                        onChange={e => setEdit(s => ({ ...s, partial: e.target.value }))}
                        placeholder={`Paid (0–${emiAmount})`}
                        className="input py-1 px-2 text-xs w-full mt-1"
                      />
                    ) : (
                      <>
                        <p className="num text-sm font-bold text-ink mt-0.5">{fmt(emiAmount)}</p>
                        {emi.status === 'PARTIALLY_PAID' && emiRemaining > 0 && (
                          <p className="text-[10px] text-amber-700 mt-0.5 font-semibold">
                            ✓ Paid {fmt(emiPaid)} · ⚠ {fmt(emiRemaining)} left
                          </p>
                        )}
                        {emi.status === 'APPROVED' && (
                          <p className="text-[10px] text-emerald-700 mt-0.5 font-semibold">✓ Fully paid</p>
                        )}
                      </>
                    )}
                  </div>

                  {/* Fine */}
                  <div className="rounded-xl border border-surface-4 bg-surface-2 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-ink-muted font-bold">Fine</p>
                    {fineOutstanding > 0 ? (
                      <>
                        <p className="num text-sm font-bold text-rose-700 mt-0.5">Due {fmt(fineOutstanding)}</p>
                        {finePaid > 0 && (
                          <p className="text-[10px] text-emerald-700 font-semibold mt-0.5">✓ Paid {fmt(finePaid)}</p>
                        )}
                        {isOverdue && (
                          <p className="text-[10px] text-rose-600/80 mt-0.5">From {format(fineStartDate, 'd MMM')}</p>
                        )}
                      </>
                    ) : totalFine > 0 && finePaid >= totalFine ? (
                      <>
                        <p className="text-sm font-bold text-emerald-700 mt-0.5">✓ Cleared</p>
                        <p className="num text-[10px] text-emerald-700 font-semibold mt-0.5">{fmt(finePaid)}</p>
                      </>
                    ) : (
                      <p className="text-sm text-ink-muted mt-0.5">—</p>
                    )}
                  </div>

                  {/* Paid On */}
                  <div className="rounded-xl border border-surface-4 bg-surface-2 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-ink-muted font-bold">Paid On</p>

                    {/* EMI payment — date/time, method, UTR */}
                    {emi.paid_at ? (
                      <p className="num text-xs font-bold text-emerald-800 mt-0.5">{fmtDateTime(emi.paid_at)}</p>
                    ) : emi.partial_paid_at ? (
                      <p className="num text-xs font-bold text-amber-800 mt-0.5">{fmtDateTime(emi.partial_paid_at)} <span className="font-normal">(partial)</span></p>
                    ) : (
                      <p className="text-sm text-ink-muted mt-0.5">—</p>
                    )}
                    {emiHasPayment && payMethod && (
                      <p className="text-[10px] text-ink-muted mt-0.5">
                        EMI method: <span className={`font-bold ${payMethod === 'UPI' ? 'text-info' : 'text-success'}`}>{payMethod}</span>
                      </p>
                    )}
                    {payMethod === 'UPI' && emi.utr && (
                      <p className="font-mono text-[10px] text-ink-muted mt-0.5">UTR {emi.utr}</p>
                    )}

                    {/* Fine payment — date/time, method, UTR */}
                    {finePaid > 0 && (emi.fine_paid_at || emi.fine_mode || emi.fine_utr) && (
                      <div className="mt-1.5 pt-1.5 border-t border-surface-4">
                        {emi.fine_paid_at && (
                          <p className="text-[10px] text-rose-700">Fine paid: <span className="num">{fmtDateTime(emi.fine_paid_at)}</span></p>
                        )}
                        {(emi.fine_mode || emi.mode) && (
                          <p className="text-[10px] text-rose-700/90 mt-0.5">
                            Fine method: <span className="font-bold">{emi.fine_mode || emi.mode}</span>
                          </p>
                        )}
                        {(emi.fine_utr || emi.utr) && (
                          <p className="font-mono text-[10px] text-rose-700/80 mt-0.5">Fine UTR {emi.fine_utr || emi.utr}</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Admin edit trigger */}
                {isAdmin && !editing && (
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <button
                      onClick={() => beginEdit(emi)}
                      className="text-[11px] px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200 transition font-medium"
                      title="Open Edit panel to change status / record payment"
                    >
                      ✏ Edit EMI {emi.emi_no}
                    </button>
                  </div>
                )}

                {/* Admin override panel — inline, inside this EMI's box */}
                {isAdmin && editing && (
                  <div className="mt-3 p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                    <p className="text-[10px] uppercase tracking-widest font-bold text-ink-muted">
                      ⚙ Super Admin Override · EMI #{emi.emi_no}
                    </p>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px]">
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
                      <label className="block md:col-span-2">
                        <span className="text-ink-muted">UTR Number</span>
                        <input
                          type="text"
                          value={edit.utr}
                          onChange={e => setEdit(s => ({ ...s, utr: e.target.value }))}
                          placeholder={emi.utr || '— none —'}
                          className="input py-1 px-2 text-xs mt-0.5 w-full"
                        />
                      </label>
                      <label className="block md:col-span-2">
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
                      <label className="block">
                        <span className="text-ink-muted">Fine already paid</span>
                        <input
                          type="number" min={0}
                          value={edit.finePaid}
                          onChange={e => setEdit(s => ({ ...s, finePaid: e.target.value }))}
                          placeholder={String(finePaid)}
                          className="input py-1 px-2 text-xs mt-0.5 w-full"
                        />
                      </label>
                      <label className="block md:col-span-3">
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
                    <p className="text-[10px] text-ink-muted">
                      Atomic write: pressing Save commits all overrides directly to this EMI row.
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {sortedEmis.length === 0 && (
          <div className="text-center text-sm text-ink-muted py-8">No EMIs scheduled yet.</div>
        )}
      </div>
    </div>
  );
}

