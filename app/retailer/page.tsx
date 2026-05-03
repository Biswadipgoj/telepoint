'use client';
export const dynamic = 'force-dynamic';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Customer, Retailer, EMISchedule, DueBreakdown, PaymentRequest } from '@/lib/types';
import NavBar from '@/components/NavBar';
import SearchInput from '@/components/SearchInput';
import CustomerDetailPanel from '@/components/CustomerDetailPanel';
import EMIScheduleTable from '@/components/EMIScheduleTable';
import DueBreakdownPanel from '@/components/DueBreakdownPanel';
import PaymentModal from '@/components/PaymentModal';
import toast from 'react-hot-toast';
import { format, differenceInDays } from 'date-fns';
import Link from 'next/link';
import { calculateTotalFineFromEmis } from '@/lib/fineCalc';
import BottomNav from '@/components/BottomNav';

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(n);
}

export default function RetailerDashboard() {
  const supabaseRef2 = useRef<ReturnType<typeof createClient> | null>(null);
  if (typeof window !== 'undefined' && !supabaseRef2.current) supabaseRef2.current = createClient();
  const supabase = supabaseRef2.current!;
  const [retailer, setRetailer] = useState<Retailer | null>(null);
  const [searchResults, setSearchResults] = useState<Customer[] | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerEmis, setCustomerEmis] = useState<EMISchedule[]>([]);
  const [breakdown, setBreakdown] = useState<DueBreakdown | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [myRequests, setMyRequests] = useState<PaymentRequest[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [upcomingEmis, setUpcomingEmis] = useState<{
    id: string; emi_no: number; due_date: string; amount: number;
    customer_name: string; imei: string; mobile: string;
  }[] | null>(null);
  const [showUpcoming, setShowUpcoming] = useState(false);

  // Broadcast messages
  const [broadcastPopups, setBroadcastPopups] = useState<{ id: string; message: string; image_url?: string | null; expires_at: string; sender_name?: string; sender_role?: string }[]>([]);
  const [dismissedBroadcasts, setDismissedBroadcasts] = useState<Set<string>>(new Set());

  // Stable refs — safe to use inside useCallback([]) without stale closure
  const supabaseRef = useRef(supabase);
  supabaseRef.current = supabase;
  const retailerRef = useRef<Retailer | null>(null);
  retailerRef.current = retailer;
  const selectCustomerRef = useRef<(c: Customer) => Promise<void>>(async () => {});

  useEffect(() => {
    loadRetailerInfo();
  }, []);

  async function loadRetailerInfo() {
    const sb = supabaseRef.current;
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return;
    const { data } = await sb.from('retailers').select('*').eq('auth_user_id', user.id).single();
    if (data) {
      setRetailer(data);
      loadMyRequests(data.id);
      // Load active broadcasts for this retailer
      const { data: broadcasts } = await sb
        .from('broadcast_messages')
.select('id, message, image_url, expires_at, sender_name, sender_role')
        .eq('target_retailer_id', data.id)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });
      if (broadcasts?.length) setBroadcastPopups(broadcasts);
    }
  }

  async function loadUpcomingEmis(retailerId: string) {
    const sb = supabaseRef.current;
    const today = new Date().toISOString().split('T')[0];
    const in5 = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { data } = await sb
      .from('emi_schedule')
      .select(`id, emi_no, due_date, amount, customer:customers(customer_name, imei, mobile, retailer_id)`)
      .in('status', ['UNPAID','PARTIALLY_PAID'])
      .gte('due_date', today)
      .lte('due_date', in5)
      .order('due_date');
    const filtered = (data || [])
      .filter((row: Record<string, unknown>) => {
        const cust = row.customer as { retailer_id?: string } | null;
        return cust?.retailer_id === retailerId;
      })
      .map((row: Record<string, unknown>) => {
        const cust = row.customer as { customer_name?: string; imei?: string; mobile?: string } | null;
        return {
          id: row.id as string,
          emi_no: row.emi_no as number,
          due_date: row.due_date as string,
          amount: row.amount as number,
          customer_name: cust?.customer_name || '',
          imei: cust?.imei || '',
          mobile: cust?.mobile || '',
        };
      });
    setUpcomingEmis(filtered);
    setShowUpcoming(true);
  }

  async function loadMyRequests(retailerId: string) {
    const { data } = await supabaseRef.current
      .from('payment_requests')
      .select('*, customer:customers(customer_name, imei)')
      .eq('retailer_id', retailerId)
      .order('created_at', { ascending: false })
      .limit(10);
    setMyRequests(data as PaymentRequest[] || []);
  }

  const handleSearch = useCallback(async (query: string) => {
    if (!query || query.length < 3) {
      setSearchResults(null);
      setSelectedCustomer(null);
      return;
    }
    const retailerId = retailerRef.current?.id;
    if (!retailerId) return; // retailer not loaded yet

    setSearchLoading(true);
    try {
      const sb = supabaseRef.current;
      let qb = sb.from('customers').select('*, retailer:retailers(*)').eq('retailer_id', retailerId);

      if (/^\d{15}$/.test(query)) {
        qb = qb.eq('imei', query);
      } else if (/^\d{12}$/.test(query)) {
        qb = qb.eq('aadhaar', query);
      } else {
        qb = qb.ilike('customer_name', `%${query}%`);
      }

      const { data, error } = await qb.order('customer_name').limit(20);
      if (error) { console.error('Search error:', error); return; }
      const results = (data as Customer[]) || [];
      setSearchResults(results);

      if (results.length === 1) {
        await selectCustomerRef.current(results[0]);
      } else {
        setSelectedCustomer(null);
      }
    } finally {
      setSearchLoading(false);
    }
  }, []);

  async function selectCustomer(customer: Customer) {
    setSelectedCustomer(customer);
    const sb = supabaseRef.current;
    const { data: emis } = await sb
      .from('emi_schedule')
      .select('*')
      .eq('customer_id', customer.id)
      .order('emi_no');
    setCustomerEmis((emis as EMISchedule[]) || []);

    const { data: bd, error: bdErr } = await sb.rpc('get_due_breakdown', { p_customer_id: customer.id });
    if (bdErr) {
      const el = (emis as EMISchedule[]) || []; const nx = el.find(e => e.status === 'UNPAID' || e.status === 'PARTIALLY_PAID');
      const af = calculateTotalFineFromEmis(el); const fc = customer.first_emi_charge_paid_at ? 0 : (customer.first_emi_charge_amount || 0);
      setBreakdown({ customer_id: customer.id, customer_status: customer.status, next_emi_no: nx?.emi_no, next_emi_amount: nx?.amount, next_emi_due_date: nx?.due_date, next_emi_status: nx?.status, fine_due: af, first_emi_charge_due: fc, total_payable: (nx?.amount ?? 0) + af + fc, popup_first_emi_charge: fc > 0, popup_fine_due: af > 0, is_overdue: nx ? new Date(nx.due_date) < new Date() : false } as DueBreakdown);
    } else setBreakdown(bd as DueBreakdown);
  }

  // Always keep ref in sync
  selectCustomerRef.current = selectCustomer;

  const paidCount = customerEmis.filter(e => e.status === 'APPROVED').length;

  return (
    <div className="min-h-screen page-bg">
      <NavBar role="retailer" userName={retailer?.name || 'Retailer'} />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-24">
        {/* Welcome Banner */}
        <div className="card p-5 mb-8 flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold text-ink">
              Welcome, {retailer?.name || 'Retailer'}
            </h1>
            <p className="text-ink-muted text-sm mt-0.5">Search your customers to collect EMI payments</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-ink-muted">Today</p>
            <p className="font-num text-sm text-ink">{format(new Date(), 'd MMM yyyy')}</p>
          </div>
        </div>

        {/* Broadcast Message Popups */}
        {broadcastPopups.filter(b => !dismissedBroadcasts.has(b.id)).map(b => (
          <div key={b.id} className="card p-4 mb-4 border-l-4 border-info bg-info-light animate-fade-in relative">
            <button
              onClick={() => setDismissedBroadcasts(prev => new Set([...prev, b.id]))}
              className="absolute top-2 right-2 text-info hover:text-ink text-sm"
            >✕</button>
            <div className="flex items-start gap-3">
              <span className="text-2xl">📢</span>
              <div>
                <p className="font-semibold text-info text-sm">Message from {b.sender_name || 'TELEPOINT'}</p>
                <p className="text-ink text-sm mt-1">{b.message}</p>
                {b.image_url && <img src={b.image_url} alt="" className="mt-2 max-h-32 rounded-xl border border-surface-4 object-cover" />}
                <p className="text-xs text-ink-muted mt-1">Valid until: {format(new Date(b.expires_at), 'd MMM yyyy')}</p>
              </div>
            </div>
          </div>
        ))}

        {/* Upcoming EMI panel */}
        <div className="mb-4 flex flex-wrap gap-2 items-center">
          <button
            onClick={() => retailer && loadUpcomingEmis(retailer.id)}
            className="btn-secondary text-sm"
          >
            🔔 Show Upcoming EMIs (Next 5 Days)
          </button>
          <a href="/api/export?type=running" download="my-running-customers.xlsx"
            className="px-3 py-2 rounded-xl border border-surface-4 hover:border-brand-300 text-ink-muted hover:text-brand-600 text-sm font-medium transition-all flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            Running
          </a>
          <a href="/api/export?type=complete" download="my-complete-customers.xlsx"
            className="px-3 py-2 rounded-xl border border-surface-4 hover:border-brand-300 text-ink-muted hover:text-brand-600 text-sm font-medium transition-all flex items-center gap-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            Complete
          </a>
        </div>

        {showUpcoming && upcomingEmis !== null && (
          <div className="card overflow-hidden mb-6 animate-fade-in">
            <div className="px-5 py-3 border-b border-white/[0.05] flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">Upcoming EMIs — Next 5 Days</span>
              <button onClick={() => setShowUpcoming(false)} className="text-xs text-ink-muted hover:text-ink">Hide</button>
            </div>
            {upcomingEmis.length === 0 ? (
              <div className="px-5 py-6 text-ink-muted text-sm text-center">No EMIs due in the next 5 days 🎉</div>
            ) : (
              <table className="data-table text-xs sm:text-sm">
                <thead>
                  <tr><th>Customer</th><th>EMI #</th><th>Due Date</th><th>Amount</th><th>Mobile</th></tr>
                </thead>
                <tbody>
                  {upcomingEmis.map(e => {
                    const daysLeft = Math.ceil((new Date(e.due_date).getTime() - Date.now()) / 86400000);
                    return (
                      <tr key={e.id}>
                        <td>
                          <p className="text-ink font-medium">{e.customer_name}</p>
                          <p className="text-xs font-num text-ink-muted">{e.imei}</p>
                        </td>
                        <td><span className="font-num">#{e.emi_no}</span></td>
                        <td>
                          <p className="text-xs font-num font-semibold text-warning">{format(new Date(e.due_date), 'd MMM yyyy')}</p>
                          <p className="text-xs text-ink-muted">{daysLeft === 0 ? 'Today' : `${daysLeft}d left`}</p>
                        </td>
                        <td><span className="font-num text-brand-600">{fmt(e.amount)}</span></td>
                        <td><span className="font-num text-ink-muted">{e.mobile}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* Search */}
        <div className="mb-6">
          <SearchInput onSearch={handleSearch} loading={searchLoading} placeholder="Search your customers by name (3+ chars), IMEI (15 digits), or Aadhaar (12 digits)..." autoFocus />
        </div>

        {/* Empty state */}
        {searchResults === null && (
          <div className="animate-fade-in">
            <div className="flex flex-col items-center justify-center py-16 text-center mb-8">
              <div className="w-20 h-20 rounded-3xl bg-surface-2 border border-white/[0.05] flex items-center justify-center mb-5">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(232,184,0,0.4)" strokeWidth="1.5">
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                </svg>
              </div>
              <p className="text-ink-muted text-lg">Search for a customer to begin</p>
              <p className="text-ink-muted text-sm mt-1">Only your own customers are shown</p>
            </div>

            {/* Recent requests */}
            {myRequests.length > 0 && (
              <div>
                <p className="section-header">Recent Payment Requests</p>
                <div className="card overflow-hidden">
                  <table className="data-table text-xs sm:text-sm">
                    <thead>
                      <tr><th>Customer</th><th>Amount</th><th>Mode</th><th>Status</th><th>Date</th><th></th></tr>
                    </thead>
                    <tbody>
                      {myRequests.map(r => {
                        const cust = r.customer as { customer_name?: string; imei?: string };
                        return (
                          <tr key={r.id}>
                            <td>
                              <p className="text-ink font-medium">{cust?.customer_name}</p>
                              <p className="text-xs text-ink-muted font-num">{cust?.imei}</p>
                            </td>
                            <td><span className="font-num font-semibold">{fmt(r.total_amount)}</span></td>
                            <td><span className={`text-xs font-semibold ${r.mode === 'UPI' ? 'text-info' : 'text-success'}`}>{r.mode}</span></td>
                            <td>
                              {r.status === 'PENDING' && <span className="badge-pending">Pending</span>}
                              {r.status === 'APPROVED' && <span className="badge-approved">Approved</span>}
                              {r.status === 'REJECTED' && <span className="badge-rejected">Rejected</span>}
                            </td>
                            <td className="text-xs text-ink-muted">{format(new Date(r.created_at), 'd MMM, h:mm a')}</td>
                            <td>
                              <Link href={`/receipt/${r.id}`} target="_blank" className="text-xs text-info hover:text-info">
                                Receipt →
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Search results list */}
        {searchResults !== null && searchResults.length === 0 && (
          <div className="text-center py-16 animate-fade-in">
            <p className="text-ink-muted">No customers found. Try a different search.</p>
          </div>
        )}

        {searchResults !== null && searchResults.length > 1 && !selectedCustomer && (
          <div className="card overflow-hidden animate-fade-in">
            <div className="px-5 py-3 border-b border-white/[0.05]">
              <span className="text-xs text-ink-muted uppercase tracking-widest">{searchResults.length} customers found</span>
            </div>
            <table className="data-table text-xs sm:text-sm">
              <thead>
                <tr><th>Name</th><th>IMEI</th><th>Mobile</th><th>Status</th><th>EMI</th><th></th></tr>
              </thead>
              <tbody>
                {searchResults.map(c => (
                  <tr key={c.id} onClick={() => selectCustomer(c)} className="cursor-pointer">
                    <td>
                      <p className="text-ink font-medium">{c.customer_name}</p>
                      {c.father_name && <p className="text-xs text-ink-muted">C/O {c.father_name}</p>}
                    </td>
                    <td><span className="font-num text-xs">{c.imei}</span></td>
                    <td><span className="font-num">{c.mobile}</span></td>
                    <td>
                      {c.status === 'RUNNING' ? <span className="badge-running">Running</span> : <span className="badge-complete">Complete</span>}
                    </td>
                    <td><span className="font-num text-brand-600">{fmt(c.emi_amount)}</span></td>
                    <td>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-ink-muted">
                        <path d="M9 18l6-6-6-6" />
                      </svg>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Selected customer view */}
        {selectedCustomer && (
          <div className="space-y-5 animate-slide-up pb-32 sm:pb-0">
            {/* Back button */}
            {searchResults && searchResults.length > 1 && (
              <button onClick={() => setSelectedCustomer(null)} className="btn-ghost flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back to results
              </button>
            )}

            <CustomerDetailPanel customer={selectedCustomer} paidCount={paidCount} totalEmis={selectedCustomer.emi_tenure} />

            {breakdown && (() => {
              const daysLeft = breakdown.next_emi_due_date ? differenceInDays(new Date(breakdown.next_emi_due_date), new Date()) : null;
              return (
                <div className="space-y-2">
                  {breakdown.fine_due > 0 && (
                    <div className="alert-red border-2">
                      <p className="font-bold text-base text-crimson-400">⚠️ Fine Pending</p>
                      <p className="text-sm font-semibold text-ink-muted mt-0.5">Pending fine: {fmt(breakdown.fine_due)}</p>
                    </div>
                  )}
                  {(breakdown.first_emi_charge_due ?? 0) > 0 && (
                    <div className="alert-gold border-2">
                      <p className="font-bold text-base text-gold-400">⚠️ 1ST EMI CHARGE Pending</p>
                      <p className="text-sm font-semibold text-ink-muted mt-0.5">Pending amount: {fmt(breakdown.first_emi_charge_due || 0)}</p>
                    </div>
                  )}
                  {daysLeft !== null && daysLeft >= 0 && daysLeft <= 5 && (
                    <div className="alert-blue border-2">
                      <p className="font-bold text-base text-sapphire-400">🔔 EMI Upcoming in {daysLeft} day{daysLeft === 1 ? '' : 's'}</p>
                      <p className="text-sm font-semibold text-ink-muted mt-0.5">
                        EMI #{breakdown.next_emi_no ?? '—'} due on {breakdown.next_emi_due_date ? format(new Date(breakdown.next_emi_due_date), 'd MMM yyyy') : '—'}
                      </p>
                    </div>
                  )}
                </div>
              );
            })()}

            {breakdown && <DueBreakdownPanel breakdown={breakdown} />}

            {/* Collect payment button — sticky on mobile, right-aligned on desktop */}
            {selectedCustomer.status === 'RUNNING' ? (() => {
              const hasUnpaidEmis = customerEmis.some(e => e.status === 'UNPAID' || e.status === 'PARTIALLY_PAID');
              return (
                <>
                  {/* Desktop: inline right-aligned */}
                  <div className="hidden sm:flex justify-end">
                    <button
                      onClick={() => setShowPaymentModal(true)}
                      disabled={!hasUnpaidEmis}
                      className="btn-primary text-base px-8 py-3.5"
                    >
                      {!hasUnpaidEmis ? '✓ All EMIs Paid' : `💳 Collect EMI #${breakdown?.next_emi_no ?? ''}`}
                    </button>
                  </div>
                  {/* Mobile: sticky bottom bar — always visible, never scrolls away */}
                  <div className="sm:hidden fixed bottom-16 left-0 right-0 z-40 px-4 pb-2 pt-3 bg-white/95 backdrop-blur-sm border-t border-surface-4 shadow-lg">
                    <button
                      onClick={() => setShowPaymentModal(true)}
                      disabled={!hasUnpaidEmis}
                      className="btn-primary w-full text-base py-4 font-semibold"
                      style={{ minHeight: 56 }}
                    >
                      {!hasUnpaidEmis
                        ? '✓ All EMIs Paid'
                        : `💳 Collect EMI #${breakdown?.next_emi_no ?? ''} · ${breakdown ? new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',minimumFractionDigits:0}).format(breakdown.total_payable) : ''}`
                      }
                    </button>
                  </div>
                </>
              );
            })() : (
              <div className="alert-blue">
                <p className="text-sapphire-300 font-semibold">✓ Account Complete</p>
                <p className="text-info/70 text-sm mt-0.5">Payment collection is not allowed for completed accounts.</p>
              </div>
            )}

            <EMIScheduleTable emis={customerEmis} nextUnpaidNo={breakdown?.next_emi_no ?? undefined} isAdmin={false} />
          </div>
        )}
      </div>

      {/* Payment Modal */}
      {showPaymentModal && selectedCustomer && (
        <PaymentModal
          customer={selectedCustomer}
          emis={customerEmis}
          breakdown={breakdown}
          onClose={() => setShowPaymentModal(false)}
          onSubmitted={() => {
            selectCustomer(selectedCustomer);
            if (retailer) loadMyRequests(retailer.id);
          }}
          isAdmin={false}
        />
      )}
      <BottomNav role="retailer" />
    </div>
  );
}
