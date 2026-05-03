'use client';
export const dynamic = 'force-dynamic';

import { useState, useEffect, useMemo } from 'react';
import { Customer, EMISchedule, DueBreakdown } from '@/lib/types';
import { format, differenceInDays } from 'date-fns';
import toast from 'react-hot-toast';
import { calculateTotalFineFromEmis, getPerEmiFineBreakdown } from '@/lib/fineCalc';
import BroadcastAnimator from '@/components/BroadcastAnimator';
import SmartAlertPopup from '@/components/SmartAlertPopup';
import { formatCurrency, formatDateOnly, readJsonSafe } from '@/lib/formatters';

const SESSION_KEY = 'emi_customer_session';
const TOKEN_KEY = 'emi_app_token';

const fmt = formatCurrency;

interface CustomerSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emis: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  breakdown: any;
}

interface MultiLoanEntry {
  id: string;
  customer_name: string;
  imei: string;
  model_no?: string;
  mobile: string;
  status: string;
  emi_amount: number;
  retailer?: { name?: string; mobile?: string };
}

export default function CustomerPortal() {
  const [aadhaar, setAadhaar] = useState('');
  const [mobile, setMobile] = useState('');
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<CustomerSession | null>(null);
  const [showUpcomingAlert, setShowUpcomingAlert] = useState(false);
  // Multi-loan selection
  const [multiLoans, setMultiLoans] = useState<MultiLoanEntry[] | null>(null);
  const [loadingLoan, setLoadingLoan] = useState(false);
  // Broadcast messages
  const [broadcastMessages, setBroadcastMessages] = useState<{ id: string; message: string; image_url?: string | null; expires_at: string; sender_name?: string; sender_role?: string }[]>([]);
  const [dismissedBroadcasts, setDismissedBroadcasts] = useState<Set<string>>(new Set());
  const [isLaunchingUpi, setIsLaunchingUpi] = useState(false);
  const [pendingWhatsappShare, setPendingWhatsappShare] = useState(false);

  // Restore session from localStorage OR auto-login via token
  useEffect(() => {
    // Check URL for ?token=xxx (app auto-login)
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('token');
    const savedToken = localStorage.getItem(TOKEN_KEY);
    const tokenToUse = urlToken || savedToken;

    if (tokenToUse) {
      // Auto-login via token
      fetch('/api/customer-app-token?token=' + tokenToUse)
        .then(readJsonSafe)
        .then((data: any) => {
          if (data?.customer) {
            const newSession: CustomerSession = {
              customer: data.customer, emis: data.emis || [], breakdown: data.breakdown || null,
            };
            setSession(newSession);
            localStorage.setItem(SESSION_KEY, JSON.stringify(newSession));
            localStorage.setItem(TOKEN_KEY, tokenToUse); // persist for future auto-login
            if (data?.broadcasts?.length) setBroadcastMessages((data.broadcasts || []) as typeof broadcastMessages);
            // Clean URL — remove token param so it's not visible
            if (urlToken) {
              window.history.replaceState({}, '', window.location.pathname);
            }
          } else {
            // Token invalid — clear and show login
            localStorage.removeItem(TOKEN_KEY);
            // Try normal session restore
            try {
              const saved = localStorage.getItem(SESSION_KEY);
              if (saved) setSession(JSON.parse(saved) as CustomerSession);
            } catch { localStorage.removeItem(SESSION_KEY); }
          }
        })
        .catch(() => {
          // Fallback to saved session
          try {
            const saved = localStorage.getItem(SESSION_KEY);
            if (saved) setSession(JSON.parse(saved) as CustomerSession);
          } catch { localStorage.removeItem(SESSION_KEY); }
        });
      return;
    }

    // No token — normal session restore
    try {
      const saved = localStorage.getItem(SESSION_KEY);
      if (saved) setSession(JSON.parse(saved) as CustomerSession);
    } catch { localStorage.removeItem(SESSION_KEY); }
  }, []);

  // Check upcoming EMI alert when session loads
  useEffect(() => {
    if (!session) return;
    const { breakdown } = session;
    if (!breakdown?.next_emi_due_date) return;
    const daysUntilDue = differenceInDays(new Date(breakdown.next_emi_due_date), new Date());
    if (daysUntilDue >= 0 && daysUntilDue <= 5) {
      setShowUpcomingAlert(true);
    }
  }, [session]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!aadhaar && !mobile) { toast.error('Enter Aadhaar or mobile number'); return; }
    if (aadhaar && aadhaar.length !== 12) { toast.error('Aadhaar must be 12 digits'); return; }
    if (mobile && mobile.length !== 10) { toast.error('Mobile must be 10 digits'); return; }

    setLoading(true);
    setMultiLoans(null);
    try {
      const res = await fetch('/api/customer-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aadhaar: aadhaar || undefined, mobile: mobile || undefined }),
      });
      const data = await readJsonSafe<{ error?: string; customer?: unknown; emis?: unknown[]; breakdown?: unknown; multi?: boolean; customers?: unknown[]; broadcasts?: unknown[] }>(res) || {};
      if (!res.ok) { toast.error(data.error); return; }

      // Multi-loan: show selection list
      if (data.multi && data.customers) {
        setMultiLoans((data.customers || []) as MultiLoanEntry[]);
        return;
      }

      const newSession: CustomerSession = {
        customer: data.customer,
        emis: data.emis,
        breakdown: data.breakdown,
      };
      setSession(newSession);
      if (data.broadcasts?.length) setBroadcastMessages((data.broadcasts || []) as typeof broadcastMessages);
      localStorage.setItem(SESSION_KEY, JSON.stringify(newSession));
    } catch {
      toast.error('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function selectLoan(customerId: string) {
    setLoadingLoan(true);
    try {
      const res = await fetch('/api/customer-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId }),
      });
      const data = await readJsonSafe<{ error?: string; customer?: unknown; emis?: unknown[]; breakdown?: unknown; multi?: boolean; customers?: unknown[]; broadcasts?: unknown[] }>(res) || {};
      if (!res.ok) { toast.error(data.error); return; }
      const newSession: CustomerSession = {
        customer: data.customer,
        emis: data.emis,
        breakdown: data.breakdown,
      };
      setSession(newSession);
      setMultiLoans(null);
      if (data.broadcasts?.length) setBroadcastMessages((data.broadcasts || []) as typeof broadcastMessages);
      localStorage.setItem(SESSION_KEY, JSON.stringify(newSession));
    } catch {
      toast.error('Something went wrong.');
    } finally {
      setLoadingLoan(false);
    }
  }

  function handleLogout() {
    setSession(null);
    setShowUpcomingAlert(false);
    setMultiLoans(null);
    localStorage.removeItem(SESSION_KEY);
    setAadhaar('');
    setMobile('');
  }

  const { customer, emis, breakdown } = session ?? { customer: null, emis: [], breakdown: null };
  const sortedEmis = useMemo(
    () => [...emis].sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime()),
    [emis],
  );
  const paidEmis = sortedEmis.filter(e => e.status === 'APPROVED');
  const unpaidEmis = sortedEmis.filter(e => e.status === 'UNPAID' || e.status === 'PARTIALLY_PAID');
  const nextUnpaidEmi = unpaidEmis[0];
  const daysUntilDue = nextUnpaidEmi
    ? differenceInDays(new Date(nextUnpaidEmi.due_date), new Date())
    : null;

  const dueSummary = useMemo(() => {
    const fineRows = sortedEmis.filter(e => !e.fine_waived).map(e => {
      const fineTotal = Math.max(Number(e.fine_amount || 0), 0);
      const finePaid = Math.max(Number(e.fine_paid_amount || 0), 0);
      return {
        emi_no: e.emi_no,
        total: fineTotal,
        paid: finePaid,
        remaining: Math.max(0, fineTotal - finePaid),
        status: fineTotal > 0 ? (finePaid === 0 ? 'DUE' : finePaid >= fineTotal ? 'PAID' : 'PARTIALLY_PAID') : 'NONE',
      };
    }).filter(r => r.total > 0 || r.paid > 0);

    const openEmi = sortedEmis.find(e => e.status === 'UNPAID' || e.status === 'PARTIALLY_PAID');
    const emiPaid = openEmi ? Math.max(0, Number(openEmi.partial_paid_amount || 0)) : 0;
    const emiDue = openEmi ? Math.max(0, Number(openEmi.amount || 0) - emiPaid) : 0;
    const totalFineRemaining = fineRows.reduce((sum, row) => sum + row.remaining, 0);
    const firstChargeDue = customer?.first_emi_charge_paid_at ? 0 : Number(customer?.first_emi_charge_amount || 0);
    return {
      emiDue,
      emiPaid,
      totalFineRemaining,
      fineRows,
      firstChargeDue,
      totalDue: emiDue + totalFineRemaining + firstChargeDue,
      nextDueDate: openEmi?.due_date || breakdown?.next_emi_due_date,
      nextEmiNo: openEmi?.emi_no || breakdown?.next_emi_no,
    };
  }, [sortedEmis, breakdown, customer]);

  async function buildReceiptFile(totalAmount: number) {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 56px sans-serif';
    ctx.fillText('TelePoint Payment Receipt', 80, 120);
    ctx.font = '36px sans-serif';
    const rows = [
      `Name: ${customer?.customer_name || '-'}`,
      `Mobile: ${customer?.mobile || '-'}`,
      `IMEI: ${customer?.imei || '-'}`,
      `EMI Due: ${fmt(dueSummary.emiDue)}`,
      `Fine Due: ${fmt(dueSummary.totalFineRemaining)}`,
      `1st EMI Charge: ${fmt(dueSummary.firstChargeDue)}`,
      `Total Amount: ${fmt(totalAmount)}`,
      `Date: ${format(new Date(), 'd MMM yyyy, h:mm a')}`,
      'Payment Mode: UPI',
      'UPI Receiver: 7003617029@upi',
    ];
    rows.forEach((row, i) => ctx.fillText(row, 80, 230 + i * 90));
    return await new Promise<File | null>((resolve) => {
      canvas.toBlob((blob) => {
        if (!blob) { resolve(null); return; }
        resolve(new File([blob], `receipt-${customer?.imei || 'emi'}.png`, { type: 'image/png' }));
      }, 'image/png');
    });
  }

  async function shareOnWhatsapp(totalAmount: number) {
    const text = [
      'TelePoint EMI Payment Update',
      `Customer: ${customer?.customer_name || '-'}`,
      `Mobile: ${customer?.mobile || '-'}`,
      `IMEI: ${customer?.imei || '-'}`,
      `EMI Due: ${fmt(dueSummary.emiDue)}`,
      `Fine Due: ${fmt(dueSummary.totalFineRemaining)}`,
      `1st EMI Charge: ${fmt(dueSummary.firstChargeDue)}`,
      `Total Paid: ${fmt(totalAmount)}`,
      `Paid On: ${format(new Date(), 'd MMM yyyy, h:mm a')}`,
    ].join('\n');
    const file = await buildReceiptFile(totalAmount);
    try {
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text, title: 'TelePoint Receipt' });
        return;
      }
    } catch {
      // fall back to whatsapp deep link
    }
    window.open(`https://wa.me/917003617029?text=${encodeURIComponent(text)}`, '_blank');
    if (file) {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
      toast('Receipt image downloaded. Attach it in WhatsApp if needed.');
    }
  }

  async function handleOnlinePay() {
    if (!customer || dueSummary.totalDue <= 0) return;
    const amount = Number(dueSummary.totalDue.toFixed(2));
    const upiUrl = `upi://pay?pa=7003617029@upi&pn=TelePoint&am=${amount}&cu=INR&tn=${encodeURIComponent(`EMI ${customer.customer_name}`)}`;
    setPendingWhatsappShare(true);
    setIsLaunchingUpi(true);
    window.location.href = upiUrl;
  }

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible' && pendingWhatsappShare && isLaunchingUpi) {
        setIsLaunchingUpi(false);
        setPendingWhatsappShare(false);
        shareOnWhatsapp(dueSummary.totalDue);
      }
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [pendingWhatsappShare, isLaunchingUpi, dueSummary.totalDue]);

  if (!session) {
    // Multi-loan selection screen
    if (multiLoans && multiLoans.length > 0) {
      return (
        <div className="min-h-screen page-bg flex items-center justify-center p-4">
          <div className="relative w-full max-w-md animate-slide-up">
            <div className="text-center mb-8">
              <h1 className="font-display text-2xl font-bold text-ink">Select Your Account</h1>
              <p className="text-slate-500 text-sm mt-1">Multiple EMI accounts found. Tap to view details.</p>
            </div>
            <div className="space-y-3">
              {multiLoans.map((loan) => (
                <button
                  key={loan.id}
                  onClick={() => selectLoan(loan.id)}
                  disabled={loadingLoan}
                  className="card w-full p-4 text-left hover:border-brand-400 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-ink">{loan.customer_name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{loan.model_no || 'Device'} · IMEI: {loan.imei}</p>
                      <p className="text-xs text-slate-500">Retailer: {loan.retailer?.name || '—'}</p>
                    </div>
                    <div className="text-right">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        loan.status === 'RUNNING' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
                      }`}>
                        {loan.status}
                      </span>
                      <p className="text-sm font-semibold text-ink mt-1">{fmt(loan.emi_amount)}/mo</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <button
              onClick={() => { setMultiLoans(null); }}
              className="btn-ghost w-full mt-4 py-2.5"
            >
              ← Back to Login
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen page-bg flex items-center justify-center p-4">
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-sapphire-500/5 blur-3xl" />
          <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-gold-500/5 blur-3xl" />
        </div>

        <div className="relative w-full max-w-md animate-slide-up">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-sapphire-500/10 border border-sapphire-500/20 mb-5">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.5">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" />
              </svg>
            </div>
            <h1 className="font-display text-3xl font-bold text-ink tracking-wide">Customer Portal</h1>
            <p className="text-slate-500 text-sm mt-1">View your EMI plan and payment history</p>
          </div>

          <div className="card p-8 shadow-2xl shadow-black/40">
            <p className="text-xs text-slate-500 text-center mb-6 tracking-wide">
              Login using Aadhaar <span className="text-slate-400">OR</span> mobile number
            </p>
            <form onSubmit={handleLogin} className="space-y-5">
              <div>
                <label className="form-label">Aadhaar Number <span className="text-slate-400 font-normal">(optional if mobile provided)</span></label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={aadhaar}
                  onChange={e => setAadhaar(e.target.value.replace(/\D/g, '').slice(0, 12))}
                  placeholder="12-digit Aadhaar number"
                  className="form-input"
                  autoFocus
                />
              </div>
              <div>
                <label className="form-label">Mobile Number <span className="text-slate-400 font-normal">(optional if Aadhaar provided)</span></label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={mobile}
                  onChange={e => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
                  placeholder="10-digit mobile number"
                  className="form-input"
                />
              </div>
              <p className="text-xs text-slate-500">
                💡 Provide at least one. If multiple accounts share a mobile, use Aadhaar for precise login.
              </p>
              <button
                type="submit"
                disabled={loading || (!aadhaar && !mobile)}
                className="btn-primary w-full py-3.5 text-base mt-2"
              >
                {loading ? 'Verifying...' : 'View My Account'}
              </button>
            </form>

            <div className="gold-line" />
            <p className="text-center text-xs text-slate-600">
              Read-only access · TelePoint EMI Portal
            </p>
          </div>

          <div className="text-center mt-6">
            <a href="/login" className="text-xs text-slate-600 hover:text-slate-400 transition-colors underline underline-offset-4">
              Staff login →
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen page-bg">
      {/* Navbar */}
      <nav className="sticky top-0 z-40 border-b border-surface-4 bg-white/90 backdrop-blur-md">
        <div className="max-w-md mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-sapphire-500/15 border border-sapphire-500/20 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2">
                <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" />
              </svg>
            </div>
            <span className="font-display text-base font-semibold text-ink">My Account</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-400 hidden sm:block">{customer?.customer_name}</span>
            <button onClick={async () => {
              const t = localStorage.getItem(TOKEN_KEY);
              if (t) {
                try {
                  const r = await fetch('/api/customer-app-token?token=' + t);
                  const d = await r.json();
                  if (d.customer) {
                    const ns = { customer: d.customer, emis: d.emis || [], breakdown: d.breakdown || null };
                    setSession(ns);
                    localStorage.setItem(SESSION_KEY, JSON.stringify(ns));
                    if (d.broadcasts?.length) setBroadcastMessages(d.broadcasts);
                    toast.success('Data refreshed');
                  }
                } catch { toast.error('Refresh failed'); }
              }
            }} className="text-xs text-jade-400 hover:text-jade-500 transition-colors border border-white/[0.08] px-3 py-1.5 rounded-lg mr-2">
              🔄 Refresh
            </button>
            <button onClick={() => { setSession(null); localStorage.removeItem(SESSION_KEY); localStorage.removeItem(TOKEN_KEY); }} className="text-xs text-slate-500 hover:text-brand-400 transition-colors border border-white/[0.08] px-3 py-1.5 rounded-lg">
              Switch
            </button>
            <button onClick={handleLogout} className="text-xs text-slate-500 hover:text-crimson-400 transition-colors border border-white/[0.08] px-3 py-1.5 rounded-lg">
              Logout
            </button>
          </div>
        </div>
      </nav>

      <div className="max-w-2xl mx-auto px-4 py-8 space-y-5">

        {/* Install App Prompt — shows on mobile when token-based and not installed as PWA */}
        {typeof window !== 'undefined' && localStorage.getItem(TOKEN_KEY) && !window.matchMedia('(display-mode: standalone)').matches && (
          <div className="card p-4 flex items-center gap-3 animate-fade-in" style={{ background: 'linear-gradient(135deg, #dbeafe, #eff6ff)', border: '2px solid #93c5fd' }}>
            <span className="text-3xl">📱</span>
            <div className="flex-1">
              <p className="font-bold text-sm text-blue-900">Install TelePoint App</p>
              <p className="text-xs text-blue-700 mt-0.5">Tap the menu button (⋮ or □↑) in your browser and select <strong>&quot;Add to Home Screen&quot;</strong> for quick access.</p>
            </div>
          </div>
        )}

                {/* Phase 6: Animated Broadcasts */}
        <BroadcastAnimator broadcasts={broadcastMessages} />

        {/* Phase 6: Smart Alert Popup */}
        <SmartAlertPopup
          fineDue={calculateTotalFineFromEmis(sortedEmis)}
          daysUntilDue={daysUntilDue}
          nextEmiNo={nextUnpaidEmi?.emi_no}
          nextEmiAmount={nextUnpaidEmi?.amount}
          firstChargeDue={breakdown?.first_emi_charge_due ?? (customer?.first_emi_charge_paid_at ? 0 : (customer?.first_emi_charge_amount || 0))}
        />

        {/* 1st EMI Charge alert */}
        {breakdown?.popup_first_emi_charge && (
          <div className="alert-gold animate-fade-in">
            <div className="flex items-center gap-3">
              <span className="text-2xl">⚠️</span>
              <div>
                <p className="text-gold-300 font-semibold">1st EMI Charge Pending</p>
                <p className="text-gold-400/70 text-sm mt-0.5">
                  A one-time charge of {fmt(breakdown.first_emi_charge_due)} is due. Contact your retailer to pay.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Fine alert */}
        {breakdown?.popup_fine_due && (
          <div className="alert-red animate-fade-in">
            <div className="flex items-center gap-3">
              <span className="text-2xl">🔴</span>
              <div>
                <p className="text-crimson-300 font-semibold">Late Fine Due</p>
                <p className="text-crimson-400/70 text-sm mt-0.5">
                  A late fine of {fmt(breakdown.fine_due)} applies. Contact your retailer.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Profile card */}
        <div className="card overflow-hidden">
          <div className="flex items-start gap-4 p-5">
            {customer?.customer_photo_url ? (
              <img
                src={customer.customer_photo_url}
                alt="Photo"
                className="w-20 h-20 rounded-2xl object-cover border border-white/10 flex-shrink-0"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div className="w-20 h-20 rounded-2xl bg-surface-3 border border-white/10 flex items-center justify-center flex-shrink-0">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5">
                  <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z" />
                </svg>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <h2 className="font-display text-2xl font-bold text-ink">{customer?.customer_name}</h2>
              {customer?.father_name && <p className="text-slate-500 text-sm">C/O {customer.father_name}</p>}
              <div className="flex flex-wrap gap-2 mt-2">
                <span className={customer?.status === 'COMPLETE' ? 'badge-complete' : 'badge-running'}>
                  {customer?.status === 'COMPLETE' ? '✓ Complete' : '● Running'}
                </span>
                {customer?.model_no && <span className="text-xs text-slate-500 bg-surface-3 px-2 py-0.5 rounded-full">{customer.model_no}</span>}
              </div>
            </div>
          </div>
          <div className="border-t border-surface-4 px-5 py-4 grid grid-cols-2 gap-4">
            <Field label="Mobile" value={customer?.mobile || ''} mono />
            <Field label="IMEI" value={customer?.imei || ''} mono />
            <Field label="Purchase Date" value={customer?.purchase_date ? format(new Date(customer.purchase_date), 'd MMM yyyy') : ''} />
            <Field label="Purchase Value" value={fmt(customer?.purchase_value || 0)} mono />
            <Field label="Down Payment" value={fmt(customer?.down_payment || 0)} mono />
            {customer?.disburse_amount && <Field label="Financed" value={fmt(customer.disburse_amount)} mono />}
          </div>
        </div>

        {/* EMI Plan */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-surface-4 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">My EMI Plan</span>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-jade-400 font-semibold">{paidEmis.length} paid</span>
              <span className="text-slate-600">/</span>
              <span className="text-slate-400">{sortedEmis.length} total</span>
            </div>
          </div>

          <div className="px-5 py-3 border-b border-surface-4">
            <div className="flex items-center justify-between mb-2 text-xs text-slate-500">
              <span>EMI Progress</span>
              <span className="font-num">{fmt(customer?.emi_amount || 0)} / month</span>
            </div>
            <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-jade-500 to-jade-400 rounded-full transition-all duration-700"
                style={{ width: `${sortedEmis.length > 0 ? (paidEmis.length / sortedEmis.length) * 100 : 0}%` }}
              />
            </div>
          </div>

          <div className="divide-y divide-white/[0.03]">
            {sortedEmis.map(emi => {
              const isOverdue = ['UNPAID', 'PARTIALLY_PAID'].includes(emi.status) && new Date(emi.due_date) < new Date();
              const daysLeft = differenceInDays(new Date(emi.due_date), new Date());
              const isUpcoming = ['UNPAID', 'PARTIALLY_PAID'].includes(emi.status) && daysLeft >= 0 && daysLeft <= 5;
              return (
                <div key={emi.id} className={`flex items-center justify-between px-5 py-3.5 ${isOverdue ? 'bg-crimson-500/5' : isUpcoming ? 'bg-yellow-50/30' : ''}`}>
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                      emi.status === 'APPROVED' ? 'bg-jade-500/20 text-jade-400' :
                      emi.status === 'PARTIALLY_PAID' ? 'bg-amber-500/20 text-amber-600' :
                      emi.status === 'PENDING_APPROVAL' ? 'bg-gold-500/20 text-gold-400' :
                      isOverdue ? 'bg-crimson-500/20 text-crimson-400' :
                      isUpcoming ? 'bg-yellow-100 text-yellow-700' : 'bg-surface-3 text-slate-500'
                    }`}>
                      {emi.emi_no}
                    </div>
                    <div>
                      <p className={`text-sm font-medium ${emi.status === 'APPROVED' ? 'text-jade-400' : isOverdue ? 'text-crimson-300' : 'text-ink'}`}>
                        EMI #{emi.emi_no}
                        {isUpcoming && !isOverdue && <span className="ml-1 text-[10px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-full font-bold">DUE SOON</span>}
                      </p>
                      <p className={`text-xs font-num ${isOverdue ? 'text-crimson-400' : 'text-slate-500'}`}>
                        Due: {format(new Date(emi.due_date), 'd MMM yyyy')}
                        {isOverdue && ' — OVERDUE'}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-num text-sm text-ink">{fmt(emi.amount)}</p>
                    <div>
                      {emi.status === 'APPROVED' && <span className="text-[10px] text-jade-400 font-semibold">✓ PAID</span>}
                      {emi.status === 'PARTIALLY_PAID' && <span className="text-[10px] text-amber-600 font-semibold">◐ PARTIAL</span>}
                      {emi.status === 'PENDING_APPROVAL' && <span className="text-[10px] text-gold-400 font-semibold">⏳ PENDING</span>}
                      {emi.status === 'UNPAID' && <span className="text-[10px] text-slate-500 font-semibold">UNPAID</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Due summary */}
                {/* Due summary with auto-calculated fine */}
        {(() => {
          const totalDue = dueSummary.totalDue;
          return totalDue > 0 ? (
            <div className="card p-5">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-widest mb-4">Next Payment Due</p>
              <div className="space-y-2.5">
                {dueSummary.emiDue > 0 && <div className="flex justify-between text-sm"><span className="text-slate-400">EMI #{dueSummary.nextEmiNo || breakdown?.next_emi_no}</span><span className="font-num text-ink">{fmt(dueSummary.emiDue)}</span></div>}
                {dueSummary.emiPaid > 0 && <div className="flex justify-between text-sm"><span className="text-amber-600">Already paid for this EMI</span><span className="font-num text-amber-600">{fmt(dueSummary.emiPaid)}</span></div>}
                {dueSummary.totalFineRemaining > 0 && <div className="flex justify-between text-sm"><span className="text-crimson-400">Fine due</span><span className="font-num text-crimson-400">{fmt(dueSummary.totalFineRemaining)}</span></div>}
                {dueSummary.firstChargeDue > 0 && <div className="flex justify-between text-sm"><span className="text-gold-400">1st EMI charge</span><span className="font-num text-gold-400">{fmt(dueSummary.firstChargeDue)}</span></div>}
                <div className="h-px bg-white/[0.06]" />
                <div className="flex justify-between"><span className="font-semibold text-ink">Total Payable</span><span className="font-num text-xl font-bold text-gold-400">{fmt(totalDue)}</span></div>
              </div>
              {dueSummary.nextDueDate && <p className="text-xs text-slate-500 mt-3">Due: {format(new Date(dueSummary.nextDueDate), 'd MMM yyyy')}</p>}
              <p className="text-xs text-slate-600 mt-2">Pay online via UPI and auto-share receipt on WhatsApp.</p>
            </div>
          ) : null;
        })()}

        {/* Fine Breakdown */}
        {(() => {
          const fb = getPerEmiFineBreakdown(sortedEmis);
          if (!fb.length) return null;
          return (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-4"><span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">⚠️ Fine Details</span></div>
              <div className="divide-y divide-white/[0.03]">
                {fb.sort((a, b) => a.emi_no - b.emi_no).map(r => (
                  <div key={r.emi_no} className="px-5 py-3 space-y-1">
                    <div className="flex justify-between"><span className="text-sm font-medium text-ink">EMI #{r.emi_no}</span><span className="text-xs text-crimson-400 font-semibold">{r.days}d overdue</span></div>
                    <div className="flex justify-between text-xs text-slate-500"><span>Base Fine</span><span className="font-num">{fmt(r.baseFineTotal)}</span></div>
                    {r.weeklyFine > 0 && <div className="flex justify-between text-xs text-slate-500"><span>+₹25/wk</span><span className="font-num">{fmt(r.weeklyFine)}</span></div>}
                    <div className="flex justify-between text-sm font-semibold"><span className="text-crimson-400">Total</span><span className="font-num text-crimson-400">{fmt(r.totalFine)}</span></div>
                    {r.paid > 0 && <div className="flex justify-between text-xs"><span className="text-jade-400">Paid{(() => { const e = sortedEmis.find(x => x.emi_no === r.emi_no); return e?.fine_paid_at ? ` (${new Date(e.fine_paid_at).toLocaleDateString('en-IN', {day:'numeric',month:'short'})})` : ''; })()}</span><span className="font-num text-jade-400">-{fmt(r.paid)}</span></div>}
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 border-t border-surface-4"><p className="text-[11px] text-slate-600">₹450 base + ₹25/week until paid. Contact retailer.</p></div>
            </div>
          );
        })()}

        {/* Fine History */}
        {(() => {
          const fineRows = sortedEmis
            .filter(e => (e.fine_amount || 0) > 0 || (e.fine_paid_amount || 0) > 0)
            .map(e => {
              const total = Number(e.fine_amount || 0);
              const paid = Number(e.fine_paid_amount || 0);
              return {
                id: e.id,
                emiNo: e.emi_no,
                detectedAt: format(new Date(e.due_date), 'd MMM yyyy'),
                total,
                paid,
                pending: Math.max(0, total - paid),
                status: total > 0 && paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'PENDING',
              };
            });
          if (!fineRows.length) return null;
          return (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-4">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">🧾 Fine History</span>
              </div>
              <div className="divide-y divide-surface-3">
                {fineRows.map(r => (
                  <div key={r.id} className="px-5 py-3 text-xs">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-ink">EMI #{r.emiNo}</p>
                      <span className={r.status === 'PAID' ? 'badge-approved' : r.status === 'PARTIALLY_PAID' ? 'badge-yellow' : 'badge-pending'}>{r.status === 'PARTIALLY_PAID' ? 'PARTIAL' : r.status}</span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                      <p className="text-slate-500">Detected Date</p><p className="text-right font-num">{r.detectedAt}</p>
                      <p className="text-slate-500">Total Fine</p><p className="text-right font-num">{fmt(r.total)}</p>
                      <p className="text-slate-500">Paid</p><p className="text-right font-num text-jade-400">{fmt(r.paid)}</p>
                      <p className="text-slate-500">Pending</p><p className="text-right font-num text-crimson-400">{fmt(r.pending)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* 1st EMI Charge status */}
        {(customer?.first_emi_charge_amount || 0) > 0 && (
          <div className={`glass-card p-4 flex items-center justify-between ${customer?.first_emi_charge_paid_at ? 'border-jade-500/20' : 'border-gold-500/20'}`}>
            <div>
              <p className="text-xs text-slate-500 mb-0.5">1st EMI Charge</p>
              <p className="font-num font-semibold text-ink">{fmt(customer?.first_emi_charge_amount || 0)}</p>
            </div>
            {customer?.first_emi_charge_paid_at ? (
              <span className="badge-approved">✓ Paid</span>
            ) : (
              <span className="badge-pending">⚠ Pending</span>
            )}
          </div>
        )}

        {/* Payment Summary — Full Transparency */}
        {session && (() => {
          const totalEmiContract = sortedEmis.reduce((s, e) => s + Number(e.amount || 0), 0);
          const totalEmiPaid = sortedEmis.reduce((s, e) => s + Math.min(Number(e.amount || 0), Number(e.partial_paid_amount || (e.status === 'APPROVED' ? e.amount : 0) || 0)), 0);
          const totalEmiRemaining = Math.max(0, totalEmiContract - totalEmiPaid);
          const totalFineAccrued = sortedEmis.reduce((s, e) => s + Math.max(Number(e.fine_amount || 0), Number(e.fine_paid_amount || 0)), 0);
          const totalFinePaid = sortedEmis.reduce((s, e) => s + Number(e.fine_paid_amount || 0), 0);
          const totalFineRemaining = Math.max(0, totalFineAccrued - totalFinePaid);
          return (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-4 bg-surface-2"><span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Payment Summary</span></div>
              <div className="grid gap-3 p-5 sm:grid-cols-2">
                <div className="rounded-2xl border border-surface-4 bg-surface-2 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">EMI Progress</p>
                  <p className="text-2xl font-semibold text-ink">{paidEmis.length}<span className="text-sm text-slate-500"> / {sortedEmis.length}</span></p>
                  <div className="mt-3 space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">EMI paid</span><span className="font-num text-jade-400">{fmt(totalEmiPaid)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">EMI remaining</span><span className="font-num text-ink">{fmt(totalEmiRemaining)}</span></div>
                  </div>
                </div>
                <div className="rounded-2xl border border-surface-4 bg-surface-2 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500 mb-1">Fine Summary</p>
                  <div className="space-y-1.5 text-sm mt-3">
                    <div className="flex justify-between"><span className="text-slate-500">Fine accrued</span><span className="font-num text-crimson-400">{fmt(totalFineAccrued)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Fine paid</span><span className="font-num text-jade-400">{fmt(totalFinePaid)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Fine remaining</span><span className="font-num text-crimson-400">{fmt(totalFineRemaining)}</span></div>
                  </div>
                </div>
                <div className="rounded-2xl border border-surface-4 bg-brand-50 p-4 sm:col-span-2 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-brand-700">Next amount due</p>
                    <p className="text-lg font-semibold text-ink">{fmt(dueSummary.totalDue)}</p>
                    <p className="text-xs text-slate-500 mt-1">EMI {fmt(dueSummary.emiDue)} · Fine {fmt(dueSummary.totalFineRemaining)} · 1st charge {fmt(dueSummary.firstChargeDue)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-500">Next due date</p>
                    <p className="font-medium text-ink">{formatDateOnly(dueSummary.nextDueDate)}</p>
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Payment History — shows paid EMIs with dates */}
        {session && sortedEmis.some(e => e.status === 'APPROVED' && e.paid_at) && (() => {
          const paidEmis = sortedEmis.filter(e => e.status === 'APPROVED' && e.paid_at);
          if (!paidEmis.length) return null;
          return (
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-4"><span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">📅 Payment History</span></div>
              <div className="divide-y divide-white/[0.03]">
                {paidEmis.map(e => (
                  <div key={e.id} className="px-5 py-2.5 flex justify-between items-center">
                    <div>
                      <p className="text-sm font-medium text-ink">EMI #{e.emi_no} — {fmt(e.amount)}</p>
                      {e.fine_paid_amount > 0 && <p className="text-xs text-crimson-400">+ Fine: {fmt(e.fine_paid_amount)}{e.fine_paid_at ? ` (${format(new Date(e.fine_paid_at), 'd MMM')})` : ''}</p>}
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-jade-400 font-semibold">✓ Paid</p>
                      {e.paid_at && <p className="text-[10px] text-slate-500">{format(new Date(e.paid_at), 'd MMM yyyy')}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-surface-4" style={{ background: 'linear-gradient(135deg, #fef3c7, #fff7ed)' }}>
            <span className="text-xs font-bold text-amber-700 uppercase tracking-widest">IMPORTANT NOTE ( নিয়মাবলী )</span>
          </div>
          <div className="px-5 py-4 text-xs text-slate-500 leading-relaxed">
            <ol className="list-decimal pl-4 space-y-2">
              <li>মোবাইল চুরি, হারানো বা খারাপ হয়ে গেলেও EMI দিতে হবে।</li>
              <li>নিদির্ষ্ট তারিখের রাত্রি ১২ টার মধ্যে EMI জমা না পড়লে Phone Auto Lock হবে। 450/- টাকা ফাইন চার্জ সহ EMI দিতে হবে।</li>
              <li>যে মাসের Fine সেই মাসের মধ্যেই পেমেন্ট করতে হবে। তা না হলে, ওই মাসের EMI Date এর ৩০ দিন পর থেকে সপ্তাহে 25/- টাকা করে (Base Fine 450/-) এর সাথে যোগ হবে।</li>
              <li>প্রতি মাসের EMI প্রতি মাসেই পেমেন্ট করতে হবে। আগের মাসের EMI বাকি রেখে বর্তমান মাসের EMI দেওয়া যাবে না।</li>
              <li>EMI চলা-কালীন মোবাইল বিক্রি / Reset করা যাবে না। Reset / Format করে ফেললে Minimum 500/- টাকা চার্জ পড়বে।</li>
              <li>EMI মিটে যাবার ৭ দিন পর Original Bill &amp; Phone Box পাওয়া যাবে।</li>
              <li>EMI এর টাকা আপনার ব্যাঙ্ক থেকে Auto Debit হবে না। Cash অথবা কার্ডে দেওয়া QR Code এ পেমেন্ট করতে পারেন।</li>
              <li>Online এ টাকা পাঠালে (7003617029) - এই নম্বরে ফোন করে জানাতে পারেন, অথবা কার্ডের প্রথম পৃষ্টার ছবি আর টাকা পাঠানোর Screen Shot টা পাঠাবেন।</li>
              <li>Portal এ পেমেন্ট Update হতে ১ - ২ দিন সময় লাগতে পারে। তারপর ও যদি না হয় দোকানে যোগাযোগ করুন।</li>
              <li>ফোন ভেঙে যাওয়া, জলে পড়ে যাওয়া, - এগুলো হলে কোন Guarantee / Warranty পাওয়া যায় না।</li>
            </ol>
          </div>
        </div>
        <p className="text-center text-xs text-slate-700 pb-4">Read-only view · TelePoint EMI Portal</p>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-slate-600 mb-0.5 uppercase tracking-wide">{label}</p>
      <p className={`text-sm text-ink ${mono ? 'font-num' : ''}`}>{value || '—'}</p>
    </div>
  );
}
