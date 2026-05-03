'use client';
import { useState, useEffect, useMemo } from 'react';
import { Customer, EMISchedule, DueBreakdown } from '@/lib/types';
import toast from 'react-hot-toast';
import { format, differenceInDays } from 'date-fns';
import { calculateSingleEmiFine, calculateTotalFineFromEmis } from '@/lib/fineCalc';
import FineSummaryPanel from './FineSummaryPanel';
import { formatCurrency, readJsonSafe } from '@/lib/formatters';

interface Props {
  customer: Customer;
  emis: EMISchedule[];
  breakdown: DueBreakdown | null;
  onClose: () => void;
  onSubmitted: () => void;
  isAdmin?: boolean;
}

const UPI_ID = 'biswajit.khanra82@axl';
const fmt = formatCurrency;

// ── Per-EMI fine calculation (single source of truth) ─────────────────────────
function calcEmiFine(emi: EMISchedule | undefined, allEmis: EMISchedule[]): number {
  if (!emi || emi.fine_waived) return 0;
  const isOverdue = ['UNPAID', 'PARTIALLY_PAID'].includes(emi.status) && new Date(emi.due_date) < new Date();
  const storedFine  = Number(emi.fine_amount || 0);
  const paidFine    = Number(emi.fine_paid_amount || 0);
  const storedUnpaid = storedFine > 0 && paidFine < storedFine;
  if (!isOverdue && !storedUnpaid) return 0;

  const maxEmiNo = allEmis.length > 0 ? Math.max(...allEmis.map(e => e.emi_no)) : 0;
  const isLast   = emi.emi_no === maxEmiNo;
  const liveFine = isOverdue ? calculateSingleEmiFine(emi.due_date, isLast) : 0;
  // Take whichever is higher — respects manual admin overrides stored in DB
  const effective = Math.max(liveFine, storedFine);
  return Math.max(0, effective - paidFine);
}

export default function PaymentModal({ customer, emis, breakdown, onClose, onSubmitted, isAdmin }: Props) {
  // ── EMI lists ───────────────────────────────────────────────────────────────
  const unpaidEmis = emis.filter(e => e.status === 'UNPAID' || e.status === 'PARTIALLY_PAID');
  // SEQUENCE LOCK: retailer must follow EMI #1 → #2 → #3 order
  const lowestUnpaidEmiNo = unpaidEmis.length > 0
    ? Math.min(...unpaidEmis.map(e => e.emi_no))
    : null;
  const defaultEmiNo = breakdown?.next_emi_no ?? unpaidEmis[0]?.emi_no ?? 0;

  // ── Core state ──────────────────────────────────────────────────────────────
  const [selectedEmiNo,   setSelectedEmiNo  ] = useState(defaultEmiNo);
  const [mode,            setMode           ] = useState<'CASH' | 'UPI'>('CASH');
  const [utr,             setUtr            ] = useState('');
  const [retailerPin,     setRetailerPin    ] = useState('');
  const [notes,           setNotes          ] = useState('');
  const [loading,         setLoading        ] = useState(false);
  const [qrDataUrl,       setQrDataUrl      ] = useState('');
  const [showReceipt,     setShowReceipt    ] = useState(false);
  const [receiptId,       setReceiptId      ] = useState('');
  const [showFineSummary, setShowFineSummary] = useState(false);

  // ── Derive values from selected EMI ─────────────────────────────────────────
  const selectedEmi = unpaidEmis.find(e => e.emi_no === selectedEmiNo)
    || emis.find(e => e.emi_no === selectedEmiNo);

  const scheduledEmiAmount = selectedEmi
    ? Math.max(0, Number(selectedEmi.amount || 0) - Number(selectedEmi.partial_paid_amount || 0))
    : 0;

  // ── FINE: ONLY for the selected EMI — NOT a global total ────────────────────
  // Each EMI's fine is independent. Selecting EMI #2 shows only EMI #2's fine.
  const scheduledFine = calcEmiFine(selectedEmi, emis);

  // Fine metadata for display
  const selectedEmiOverdueDays = selectedEmi && new Date(selectedEmi.due_date) < new Date()
    ? differenceInDays(new Date(), new Date(selectedEmi.due_date))
    : 0;
  const finePaidForSelectedEmi = Number(selectedEmi?.fine_paid_amount || 0);

  // Total fine across ALL overdue EMIs — used ONLY for the summary awareness row
  const totalFineAllEmis = calculateTotalFineFromEmis(emis);
  // Other EMIs (not selected) that also have pending fines
  const otherEmisWithFine = emis.filter(e =>
    e.emi_no !== selectedEmiNo && calcEmiFine(e, emis) > 0
  );

  const scheduledCharge = breakdown?.first_emi_charge_due
    ?? (customer.first_emi_charge_paid_at ? 0 : (customer.first_emi_charge_amount || 0));

  // ── Collection checkboxes ────────────────────────────────────────────────────
  const [collectEmi,    setCollectEmi   ] = useState(true);
  const [collectFine,   setCollectFine  ] = useState(scheduledFine > 0);
  const [collectCharge, setCollectCharge] = useState(scheduledCharge > 0);
  const [editEmi,       setEditEmi      ] = useState('');
  const [editFine,      setEditFine     ] = useState('');
  const [editCharge,    setEditCharge   ] = useState('');

  // ── Computed amounts ─────────────────────────────────────────────────────────
  const emiAmt    = collectEmi    ? (editEmi    !== '' ? Math.max(0, parseFloat(editEmi)    || 0) : scheduledEmiAmount) : 0;
  const fineAmt   = collectFine   ? (editFine   !== '' ? Math.max(0, parseFloat(editFine)   || 0) : scheduledFine)      : 0;
  const chargeAmt = collectCharge ? (editCharge !== '' ? Math.max(0, parseFloat(editCharge) || 0) : scheduledCharge)    : 0;
  const total     = emiAmt + fineAmt + chargeAmt;

  const missingRetailPin = !isAdmin && !retailerPin.trim();
  const missingUtr       = mode === 'UPI' && !utr.trim();
  const cannotSubmit     = loading || total <= 0 || missingRetailPin || missingUtr || (collectEmi && !selectedEmi);

  // ── Mobile Payment Summary ───────────────────────────────────────────────────
  // Depends on selectedEmiNo so it's in the deps array
  const loanSummary = useMemo(() => {
    const paidEmis   = emis.filter(e => e.status === 'APPROVED');
    const loanAmount = customer.purchase_value || 0;
    const amountPaid = paidEmis.reduce((s, e) => s + Number(e.amount || 0), 0);
    const amountDue  = emis
      .filter(e => e.status !== 'APPROVED')
      .reduce((s, e) => s + Math.max(0, Number(e.amount || 0) - Number(e.partial_paid_amount || 0)), 0);
    // totalPayable = current EMI remaining + THIS EMI's fine only
    const totalPayable = scheduledEmiAmount + scheduledFine;
    return {
      loanAmount, amountPaid, amountDue,
      fineDue: totalFineAllEmis,       // ALL EMIs total — for awareness
      selectedEmiFine: scheduledFine,  // this EMI only — for collect section
      totalPayable,
      paidCount: paidEmis.length,
      totalEmiCount: emis.length,
    };
  // selectedEmiNo change updates scheduledEmiAmount and scheduledFine
  }, [emis, customer.purchase_value, selectedEmiNo, breakdown]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Effects ──────────────────────────────────────────────────────────────────

  // Set initial EMI if default is 0
  useEffect(() => {
    if (selectedEmiNo === 0 && unpaidEmis.length > 0) {
      setSelectedEmiNo(unpaidEmis[0].emi_no);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When selected EMI changes: reset edits AND re-evaluate fine checkbox
  useEffect(() => {
    setEditEmi('');
    setEditFine('');
    setEditCharge('');
    // Re-derive fine for the newly selected EMI
    const fineForNewEmi = calcEmiFine(
      unpaidEmis.find(e => e.emi_no === selectedEmiNo) || emis.find(e => e.emi_no === selectedEmiNo),
      emis
    );
    setCollectFine(fineForNewEmi > 0);
  }, [selectedEmiNo]); // eslint-disable-line react-hooks/exhaustive-deps

  // QR code generation
  useEffect(() => {
    if (mode === 'UPI' && total > 0) {
      import('qrcode').then(QR => {
        QR.toDataURL(
          `upi://pay?pa=${UPI_ID}&pn=TelePoint&am=${total}&tn=EMI${selectedEmiNo}_${customer.imei.slice(-6)}&cu=INR`,
          { width: 240, margin: 2, color: { dark: '#1e293b', light: '#ffffff' } }
        ).then(setQrDataUrl);
      }).catch(() => {});
    } else {
      setQrDataUrl('');
    }
  }, [mode, total, selectedEmiNo, customer.imei]);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function getCollectType() {
    if (collectEmi && collectFine && collectCharge) return 'emi_full_due';
    if (collectEmi && collectFine)                  return 'emi_fine';
    if (collectEmi && collectCharge)                return 'emi_first_charge';
    if (collectEmi)                                 return 'emi_only';
    if (collectFine)                                return 'fine_only';
    if (collectCharge)                              return 'first_charge_only';
    return 'emi_only';
  }

  // ── Submit ───────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (collectEmi && !selectedEmi)      { toast.error('Select an EMI'); return; }
    if (!isAdmin && !retailerPin.trim()) { toast.error('Enter Retail PIN'); return; }
    if (mode === 'UPI' && !utr.trim())   { toast.error('UTR required for UPI'); return; }
    if (total <= 0)                      { toast.error('Total must be > 0'); return; }

    setLoading(true);
    try {
      const res = await fetch(isAdmin ? '/api/payments/approve-direct' : '/api/payments/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id:              customer.id,
          emi_ids:                  collectEmi && selectedEmi ? [selectedEmi.id]     : [],
          emi_nos:                  collectEmi && selectedEmi ? [selectedEmi.emi_no] : [],
          mode,
          utr:                      mode === 'UPI' ? utr.trim() : null,
          notes:                    notes || null,
          retail_pin:               isAdmin ? undefined : retailerPin,
          total_emi_amount:         emiAmt,
          scheduled_emi_amount:     scheduledEmiAmount,
          // Fine is specifically for the selected EMI — not a global total
          fine_amount:              fineAmt,
          first_emi_charge_amount:  chargeAmt,
          total_amount:             total,
          // Tell the server WHICH EMI this fine belongs to
          fine_for_emi_no:          fineAmt > 0 ? selectedEmiNo : undefined,
          fine_due_date:            fineAmt > 0 && selectedEmi ? selectedEmi.due_date : undefined,
          collected_by_role:        isAdmin ? 'admin' : 'retailer',
          collect_type:             getCollectType(),
        }),
      });
      const data = await readJsonSafe<{ error?: string; request_id?: string }>(res) || { error: 'Server error' };
      if (!res.ok) {
        toast.error(data.error || 'Submission failed');
      } else {
        toast.success(isAdmin ? '✅ Payment approved!' : '📋 Request submitted for approval');
        if (data.request_id) { setReceiptId(data.request_id); setShowReceipt(true); }
        else { onSubmitted(); onClose(); }
      }
    } catch (e) {
      toast.error('Failed: ' + (e instanceof Error ? e.message : 'Network error'));
    } finally {
      setLoading(false);
    }
  }

  // ── Receipt screen ────────────────────────────────────────────────────────────
  if (showReceipt && receiptId) {
    const now = new Date();
    return (
      <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) { onSubmitted(); onClose(); } }}>
        <div className="modal-panel max-w-sm mx-auto animate-scale-in">
          <div className="bg-brand-500 px-6 py-5 text-center">
            <div className="text-4xl mb-2">{isAdmin ? '✅' : '📋'}</div>
            <h2 className="text-white font-bold text-xl">{isAdmin ? 'Payment Approved' : 'Request Submitted'}</h2>
          </div>
          <div className="p-5 space-y-3">
            <div className="card bg-surface-2 p-4 space-y-2">
              <div className="flex justify-between text-sm"><span className="text-ink-muted">Customer</span><span className="font-semibold text-ink">{customer.customer_name}</span></div>
              <div className="flex justify-between text-sm"><span className="text-ink-muted">IMEI</span><span className="num text-ink">{customer.imei}</span></div>
              {emiAmt > 0 && <div className="flex justify-between text-sm"><span className="text-ink-muted">EMI #{selectedEmiNo}</span><span className="num font-semibold">{fmt(emiAmt)}</span></div>}
              {chargeAmt > 0 && <div className="flex justify-between text-sm"><span className="text-warning">1st Charge</span><span className="num text-warning">{fmt(chargeAmt)}</span></div>}
              {fineAmt > 0 && <div className="flex justify-between text-sm"><span className="text-danger">Fine (EMI #{selectedEmiNo})</span><span className="num text-danger">{fmt(fineAmt)}</span></div>}
              <div className="h-px bg-surface-4" />
              <div className="flex justify-between"><span className="font-bold">Total</span><span className="num text-xl font-bold text-brand-600">{fmt(total)}</span></div>
              <div className="text-[10px] text-ink-muted">{mode === 'UPI' && utr ? `UTR: ${utr}` : mode}</div>
            </div>
            <button
              onClick={() => {
                const lines = [
                  `🧾 *TelePoint EMI Receipt*`, '',
                  `👤 ${customer.customer_name}`, `📱 ${customer.mobile}`,
                  `🔢 IMEI: ${customer.imei}`, '',
                  emiAmt > 0    ? `💳 EMI #${selectedEmiNo}: ${fmt(emiAmt)}` : '',
                  chargeAmt > 0 ? `⭐ Charge: ${fmt(chargeAmt)}` : '',
                  fineAmt > 0   ? `⚠️ Fine (EMI #${selectedEmiNo}): ${fmt(fineAmt)}` : '',
                  `💰 *Total: ${fmt(total)}*`, `🏷️ ${mode}`,
                  mode === 'UPI' && utr ? `UTR: ${utr}` : '',
                  `📅 ${format(now, 'd MMM yyyy, h:mm a')}`, '', '— TelePoint',
                ].filter(Boolean).join('\n');
                window.open(`https://wa.me/?text=${encodeURIComponent(lines)}`, '_blank');
              }}
              className="btn w-full py-3 bg-green-500 hover:bg-green-600 text-white rounded-xl font-semibold">
              📤 Share on WhatsApp
            </button>
            <button onClick={() => { onSubmitted(); onClose(); }} className="btn-ghost w-full py-2.5">
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (showFineSummary) return <FineSummaryPanel emis={emis} onClose={() => setShowFineSummary(false)} />;

  // ── Main modal ───────────────────────────────────────────────────────────────
  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel flex flex-col max-h-[95dvh]">

        {/* ── Sticky header ───────────────────────────────────────────────────── */}
        <div className="sticky top-0 z-10 bg-white border-b border-surface-4 px-4 py-3 flex items-center justify-between shrink-0">
          <div>
            <h2 className="font-bold text-ink text-base leading-tight">
              {isAdmin ? 'Record Payment' : 'Submit Payment'}
            </h2>
            <p className="text-ink-muted text-xs mt-0.5">{customer.customer_name} · {customer.imei}</p>
          </div>
          <button onClick={onClose} className="btn-icon shrink-0" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* ── Scrollable body ──────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* ── MOBILE PAYMENT SUMMARY CARD ─────────────────────────────────── */}
          <div className="rounded-2xl overflow-hidden border border-brand-200 shadow-sm">
            {/* Header gradient */}
            <div className="bg-gradient-to-r from-brand-600 to-brand-500 px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-white/80 text-[10px] font-semibold uppercase tracking-widest">Loan Summary</p>
                <p className="text-white font-bold text-sm mt-0.5">{customer.customer_name}</p>
              </div>
              <div className="text-right">
                <p className="text-white/70 text-[10px]">EMIs</p>
                <p className="text-white font-bold text-lg">{loanSummary.paidCount}/{loanSummary.totalEmiCount}</p>
              </div>
            </div>
            {/* Summary grid */}
            <div className="bg-brand-50 grid grid-cols-2 divide-x divide-y divide-brand-200">
              <div className="p-3">
                <p className="text-[10px] text-ink-muted uppercase tracking-wide font-medium">Loan Amount</p>
                <p className="num font-bold text-ink mt-0.5">{fmt(loanSummary.loanAmount)}</p>
              </div>
              <div className="p-3">
                <p className="text-[10px] text-ink-muted uppercase tracking-wide font-medium">Amount Paid</p>
                <p className="num font-bold text-success mt-0.5">{fmt(loanSummary.amountPaid)}</p>
              </div>
              <div className="p-3">
                <p className="text-[10px] text-ink-muted uppercase tracking-wide font-medium">Amount Due</p>
                <p className="num font-bold text-ink mt-0.5">{fmt(loanSummary.amountDue)}</p>
              </div>
              <div className="p-3">
                <p className="text-[10px] text-ink-muted uppercase tracking-wide font-medium">
                  All Fines Due
                  {loanSummary.fineDue > 0 && loanSummary.selectedEmiFine < loanSummary.fineDue && (
                    <span className="ml-1 text-danger">●</span>
                  )}
                </p>
                <p className={`num font-bold mt-0.5 ${loanSummary.fineDue > 0 ? 'text-danger' : 'text-ink-muted'}`}>
                  {loanSummary.fineDue > 0 ? fmt(loanSummary.fineDue) : '—'}
                </p>
              </div>
            </div>
            {/* Total payable — specific to selected EMI */}
            <div className="bg-brand-500 px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-white/80 text-[10px] font-semibold uppercase tracking-wide">
                  Payable Now · EMI #{selectedEmiNo || '—'}
                </p>
                <p className="text-white/70 text-[10px] mt-0.5">
                  {scheduledEmiAmount > 0 ? `EMI ${fmt(scheduledEmiAmount)}` : ''}
                  {scheduledFine > 0 ? ` + Fine ${fmt(scheduledFine)}` : ''}
                </p>
              </div>
              <p className="num text-2xl font-bold text-white">{fmt(loanSummary.totalPayable)}</p>
            </div>
          </div>

          {/* ── OTHER EMIs WITH PENDING FINES — informational alert ──────────── */}
          {otherEmisWithFine.length > 0 && (
            <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-warning-light border border-warning-border">
              <span className="text-base shrink-0 mt-0.5">ℹ️</span>
              <div>
                <p className="text-xs font-semibold text-warning">Other EMIs also have pending fines</p>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  {otherEmisWithFine.map(e => `EMI #${e.emi_no}: ${fmt(calcEmiFine(e, emis))}`).join(' · ')}
                </p>
                <button
                  type="button"
                  onClick={() => setShowFineSummary(true)}
                  className="text-[11px] text-brand-600 font-semibold mt-1 underline underline-offset-2">
                  View all fines →
                </button>
              </div>
            </div>
          )}

          {/* ── WHAT TO COLLECT ─────────────────────────────────────────────── */}
          <div className="card bg-surface-2 p-4 space-y-3">
            <p className="text-xs font-bold text-ink-muted uppercase tracking-widest">Collect for EMI #{selectedEmiNo || '—'}</p>

            {/* EMI amount row */}
            <label className={`flex items-center justify-between p-3 rounded-xl border-2 cursor-pointer transition-all ${collectEmi ? 'border-brand-400 bg-brand-50' : 'border-surface-4'}`}>
              <div className="flex items-center gap-3">
                <input type="checkbox" checked={collectEmi} onChange={e => setCollectEmi(e.target.checked)} className="w-5 h-5 accent-brand-500 rounded" />
                <div>
                  <p className="text-sm font-semibold text-ink">💳 EMI #{selectedEmiNo || '—'}</p>
                  <p className="text-xs text-ink-muted">
                    Due: {fmt(selectedEmi?.amount || 0)}
                    {selectedEmi && Number(selectedEmi.partial_paid_amount || 0) > 0
                      ? ` · Paid ${fmt(selectedEmi.partial_paid_amount || 0)} · Remaining ${fmt(scheduledEmiAmount)}`
                      : ''
                    }
                  </p>
                </div>
              </div>
              <span className="num font-bold text-ink">{fmt(scheduledEmiAmount)}</span>
            </label>

            {/* Fine — specific to selected EMI only */}
            {scheduledFine > 0 && (
              <label className={`flex items-center justify-between p-3 rounded-xl border-2 cursor-pointer transition-all ${collectFine ? 'border-danger bg-danger-light' : 'border-surface-4'}`}>
                <div className="flex items-center gap-3">
                  <input type="checkbox" checked={collectFine} onChange={e => setCollectFine(e.target.checked)} className="w-5 h-5 accent-red-500 rounded" />
                  <div>
                    <p className="text-sm font-semibold text-danger">⚠️ Fine — EMI #{selectedEmiNo}</p>
                    <p className="text-xs text-ink-muted">
                      {selectedEmiOverdueDays > 0
                        ? `${selectedEmiOverdueDays}d overdue · since ${format(new Date(selectedEmi!.due_date), 'd MMM')}`
                        : 'Outstanding balance'}
                      {finePaidForSelectedEmi > 0 && ` · ${fmt(finePaidForSelectedEmi)} already paid`}
                    </p>
                  </div>
                </div>
                <span className="num font-bold text-danger">{fmt(scheduledFine)}</span>
              </label>
            )}

            {/* 1st EMI charge */}
            {scheduledCharge > 0 && (
              <label className={`flex items-center justify-between p-3 rounded-xl border-2 cursor-pointer transition-all ${collectCharge ? 'border-warning bg-warning-light' : 'border-surface-4'}`}>
                <div className="flex items-center gap-3">
                  <input type="checkbox" checked={collectCharge} onChange={e => setCollectCharge(e.target.checked)} className="w-5 h-5 accent-amber-500 rounded" />
                  <div>
                    <p className="text-sm font-semibold text-warning">⭐ 1st EMI Charge</p>
                    <p className="text-xs text-ink-muted">One-time, not yet collected</p>
                  </div>
                </div>
                <span className="num font-bold text-warning">{fmt(scheduledCharge)}</span>
              </label>
            )}

            {/* No fine message */}
            {scheduledFine === 0 && selectedEmiOverdueDays === 0 && (
              <p className="text-xs text-success text-center py-1">✓ No fine due on EMI #{selectedEmiNo}</p>
            )}
          </div>

          {/* ── EMI SELECTOR ────────────────────────────────────────────────── */}
          {collectEmi && (
            <div>
              <label className="label">Select EMI *</label>
              {unpaidEmis.length === 0 ? (
                <p className="text-success font-semibold text-sm py-3 text-center">✓ All EMIs paid</p>
              ) : (
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {unpaidEmis.map(emi => {
                    const sel      = selectedEmiNo === emi.emi_no;
                    const isLocked = !isAdmin && lowestUnpaidEmiNo !== null && emi.emi_no !== lowestUnpaidEmiNo;
                    const isOverdue = new Date(emi.due_date) < new Date();
                    const emiFineAmt = calcEmiFine(emi, emis);
                    const emiPartialPaid = Number(emi.partial_paid_amount || 0);
                    const emiRemaining   = Math.max(0, Number(emi.amount || 0) - emiPartialPaid);

                    return (
                      <button
                        key={emi.id}
                        type="button"
                        onClick={() => { if (!isLocked) setSelectedEmiNo(emi.emi_no); }}
                        disabled={isLocked}
                        title={isLocked ? `Pay EMI #${lowestUnpaidEmiNo} first` : undefined}
                        className={`w-full rounded-xl border-2 text-left transition-all overflow-hidden ${
                          isLocked
                            ? 'opacity-40 cursor-not-allowed border-surface-4'
                            : sel
                            ? 'border-brand-400 shadow-sm'
                            : 'border-surface-4 hover:border-surface-5'
                        }`}
                      >
                        {/* EMI row top */}
                        <div className={`flex items-center justify-between px-3 py-2.5 ${sel ? 'bg-brand-50' : 'bg-white'}`}>
                          <div className="flex items-center gap-2.5">
                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${sel ? 'bg-brand-500 border-brand-500' : 'border-surface-4'}`}>
                              {sel && <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4"><path d="M20 6L9 17l-5-5"/></svg>}
                            </div>
                            <div>
                              <p className={`text-sm font-semibold leading-tight ${sel ? 'text-brand-700' : isLocked ? 'text-ink-muted' : 'text-ink'}`}>
                                EMI #{emi.emi_no}
                                {emi.status === 'PARTIALLY_PAID' && (
                                  <span className="ml-1.5 text-[9px] bg-warning-light text-warning border border-warning-border px-1 py-0.5 rounded-full">Partial</span>
                                )}
                              </p>
                              {isLocked && (
                                <p className="text-[9px] text-ink-muted leading-tight">Pay #{lowestUnpaidEmiNo} first</p>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="num text-sm font-bold">
                              {emiPartialPaid > 0 ? fmt(emiRemaining) : fmt(emi.amount)}
                            </p>
                            <p className={`text-[10px] ${isOverdue ? 'text-danger' : 'text-ink-muted'}`}>
                              {format(new Date(emi.due_date), 'd MMM')}
                              {isOverdue && ' ⚠'}
                            </p>
                          </div>
                        </div>
                        {/* Fine indicator strip — shows THIS EMI's fine inline */}
                        {emiFineAmt > 0 && (
                          <div className={`flex items-center justify-between px-3 py-1.5 border-t ${sel ? 'bg-danger-light/60 border-danger-border' : 'bg-danger-light/30 border-danger-border/40'}`}>
                            <p className="text-[11px] text-danger font-medium">
                              ⚠ Fine for this EMI
                              {isOverdue ? ` · ${differenceInDays(new Date(), new Date(emi.due_date))}d overdue` : ''}
                            </p>
                            <p className="num text-[11px] font-semibold text-danger">{fmt(emiFineAmt)}</p>
                          </div>
                        )}
                        {/* Partial paid strip */}
                        {emiPartialPaid > 0 && (
                          <div className={`flex items-center justify-between px-3 py-1 border-t ${sel ? 'bg-success-light border-success-border' : 'bg-success-light/40 border-success-border/40'}`}>
                            <p className="text-[11px] text-success font-medium">✓ Partial paid</p>
                            <p className="num text-[11px] font-semibold text-success">{fmt(emiPartialPaid)}</p>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── PAYMENT MODE ────────────────────────────────────────────────── */}
          <div>
            <label className="label">Payment Mode</label>
            <div className="flex gap-2">
              {(['CASH', 'UPI'] as const).map(m => (
                <button key={m} type="button" onClick={() => setMode(m)}
                  className={`flex-1 py-3 rounded-xl border-2 text-sm font-semibold transition-all ${mode === m
                    ? m === 'CASH'
                      ? 'border-success bg-success-light text-success'
                      : 'border-info bg-info-light text-info'
                    : 'border-surface-4 text-ink-muted'}`}>
                  {m === 'CASH' ? '💵 Cash' : '📱 UPI'}
                </button>
              ))}
            </div>
          </div>

          {/* UTR — shown immediately when UPI is selected */}
          {mode === 'UPI' && (
            <div>
              <label className="label">UTR / Reference Number *</label>
              <input
                type="text"
                value={utr}
                onChange={e => setUtr(e.target.value)}
                placeholder="Enter UTR number"
                className={`input ${!utr.trim() ? 'border-warning' : 'border-success'}`}
              />
              {!utr.trim() && (
                <p className="text-[11px] text-warning mt-1 flex items-center gap-1">
                  <span>⚠</span> UTR is mandatory for UPI payments
                </p>
              )}
            </div>
          )}

          {/* QR code */}
          {mode === 'UPI' && qrDataUrl && (
            <div className="flex flex-col items-center gap-1.5">
              <img src={qrDataUrl} alt="UPI QR Code" className="w-44 h-44 rounded-2xl border border-surface-4 shadow-sm" />
              <p className="num text-xs text-ink-muted">{UPI_ID}</p>
            </div>
          )}

          {/* Retailer PIN */}
          {!isAdmin && (
            <div>
              <label className="label">Retail PIN *</label>
              <input
                type="password"
                value={retailerPin}
                onChange={e => setRetailerPin(e.target.value)}
                placeholder="Enter your PIN"
                inputMode="numeric"
                className={`input ${missingRetailPin ? 'border-warning' : ''}`}
              />
              {missingRetailPin && (
                <p className="text-[11px] text-warning mt-1">⚠ PIN required to submit</p>
              )}
            </div>
          )}

          {/* Notes */}
          <div>
            <label className="label">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              placeholder="Any remarks..."
              className="input resize-none"
            />
          </div>

          {/* Editable amount overrides */}
          <div className="card bg-surface-2 p-3 space-y-2">
            <p className="text-xs font-bold text-ink-muted uppercase tracking-widest">
              Amounts <span className="font-normal text-brand-500">(tap to override)</span>
            </p>
            {collectEmi && (
              <div className="flex items-center gap-3">
                <label className="text-xs text-ink-muted w-20 shrink-0">EMI #{selectedEmiNo}</label>
                <input type="number" min={0} value={editEmi} onChange={e => setEditEmi(e.target.value)}
                  placeholder={String(scheduledEmiAmount)} className="input flex-1 py-2 text-sm" inputMode="numeric" />
              </div>
            )}
            {collectFine && scheduledFine > 0 && (
              <div className="flex items-center gap-3">
                <label className="text-xs text-danger w-20 shrink-0">Fine #{selectedEmiNo}</label>
                <input type="number" min={0} value={editFine} onChange={e => setEditFine(e.target.value)}
                  placeholder={String(scheduledFine)} className="input flex-1 py-2 text-sm" inputMode="numeric" />
              </div>
            )}
            {collectCharge && scheduledCharge > 0 && (
              <div className="flex items-center gap-3">
                <label className="text-xs text-warning w-20 shrink-0">1st Charge</label>
                <input type="number" min={0} value={editCharge} onChange={e => setEditCharge(e.target.value)}
                  placeholder={String(scheduledCharge)} className="input flex-1 py-2 text-sm" inputMode="numeric" />
              </div>
            )}
          </div>

          {/* Running total */}
          <div className="flex items-center justify-between px-4 py-3.5 rounded-2xl bg-brand-600 shadow-md">
            <div>
              <p className="text-white/70 text-[10px] font-semibold uppercase tracking-wide">Total to Collect</p>
              <p className="text-white/80 text-[11px] mt-0.5">
                {[
                  emiAmt > 0    ? `EMI ${fmt(emiAmt)}` : '',
                  fineAmt > 0   ? `Fine ${fmt(fineAmt)}` : '',
                  chargeAmt > 0 ? `Charge ${fmt(chargeAmt)}` : '',
                ].filter(Boolean).join(' + ')}
              </p>
            </div>
            <span className="num text-3xl font-bold text-white">{fmt(total)}</span>
          </div>

        </div>

        {/* ── FIXED BOTTOM ACTION BAR — always visible on all screen sizes ──── */}
        <div
          className="shrink-0 bg-white border-t border-surface-4 px-3 py-3 flex gap-3"
          style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
        >
          <button
            onClick={onClose}
            className="btn-secondary flex-1 font-semibold"
            style={{ minHeight: 52, fontSize: 15 }}>
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={cannotSubmit}
            className="btn-primary flex-1 font-semibold"
            style={{ minHeight: 52, fontSize: 15 }}>
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeDashoffset="10"/>
                </svg>
                Processing…
              </span>
            ) : isAdmin
              ? `✓ Record · ${fmt(total)}`
              : `→ Submit · ${fmt(total)}`
            }
          </button>
        </div>

      </div>
    </div>
  );
}
