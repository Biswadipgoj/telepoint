export const dynamic = 'force-dynamic';
import React from 'react';
import { createServiceClient } from '@/lib/supabase/server';
import { format } from 'date-fns';
import { notFound } from 'next/navigation';
import PrintButton from '@/components/PrintButton';

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(n);
}

type Status = 'PENDING' | 'APPROVED' | 'REJECTED';

export default async function ReceiptPage({ params }: { params: { id: string } }) {
  // Use service client — receipt URLs are public (shared via WhatsApp etc.)
  const supabase = createServiceClient();

  const { data: request } = await supabase
    .from('payment_requests')
    .select(`
      *,
      customer:customers(customer_name, father_name, imei, mobile, model_no, aadhaar, first_emi_charge_amount, retailer:retailers(name, mobile)),
      retailer:retailers(name, username, mobile),
      items:payment_request_items(emi_no, amount)
    `)
    .eq('id', params.id)
    .single();

  if (!request) notFound();

  const status: Status = (request.status as Status) ?? 'PENDING';
  const customer = request.customer as {
    customer_name?: string; father_name?: string; imei?: string; mobile?: string;
    model_no?: string; aadhaar?: string; first_emi_charge_amount?: number;
    retailer?: { name?: string; mobile?: string };
  } | null;
  const retailer = request.retailer as { name?: string; username?: string; mobile?: string } | null;
  const items = (request.items as { emi_no: number; amount: number }[]) ?? [];

  const statusMeta: Record<Status, { color: string; bg: string; border: string; label: string; emoji: string }> = {
    PENDING:  { color: '#92400e', bg: '#fef3c7', border: '#fcd34d', label: 'Pending Approval', emoji: '⏳' },
    APPROVED: { color: '#1d4ed8', bg: '#dbeafe', border: '#93c5fd', label: 'Approved', emoji: '✅' },
    REJECTED: { color: '#991b1b', bg: '#fee2e2', border: '#fca5a5', label: 'Rejected', emoji: '❌' },
  };
  const sm = statusMeta[status];

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(135deg, #fefce8 0%, #f0f9ff 60%, #f8fafc 100%)', padding: '2rem 1rem', fontFamily: 'DM Sans, system-ui, sans-serif' }}>
      <div style={{ maxWidth: '480px', margin: '0 auto' }}>

        {/* Print / action buttons */}
        <div id="no-print" style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
          <PrintButton />
          {/* Download receipt via API — works on mobile too */}
          <a
            href={`/api/receipt/${params.id}`}
            download={`receipt-${params.id.slice(0, 8)}.html`}
            style={{ padding: '0.625rem 1.25rem', background: '#1d4ed8', color: 'white', border: 'none', borderRadius: '0.75rem', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.5rem', textDecoration: 'none' }}
          >
            ⬇️ Download Receipt
          </a>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(
              [
                `🧾 *TelePoint EMI Receipt*`,
                ``,
                `👤 ${customer?.customer_name ?? ''}`,
                `📱 ${customer?.mobile ?? ''}`,
                `🔢 IMEI: ${customer?.imei ?? ''}`,
                ``,
                `💰 Total Paid: ₹${request.total_amount}`,
                `🏷️ Mode: ${request.mode}`,
                `📅 ${format(new Date(request.created_at), 'd MMM yyyy')}`,
                ``,
                `Receipt: ${process.env.NEXT_PUBLIC_APP_URL || ''}/receipt/${params.id}`,
              ].join('\n')
            )}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ padding: '0.625rem 1.25rem', background: '#25d366', color: 'white', border: 'none', borderRadius: '0.75rem', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.5rem', textDecoration: 'none' }}
          >
            📲 Share WhatsApp
          </a>
        </div>

        {/* Receipt card */}
        <div style={{ background: 'white', borderRadius: '1.5rem', overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.12)', border: '1px solid #e2e8f0' }}>

          {/* Brand header */}
          <div style={{ background: 'linear-gradient(135deg, #eab308 0%, #ca8a04 100%)', padding: '1.75rem 2rem', textAlign: 'center' }}>
            <div style={{ width: '3.5rem', height: '3.5rem', background: 'rgba(255,255,255,0.2)', borderRadius: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 0.75rem' }}>
              <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                <path d="M16 2L2 9V23L16 30L30 23V9L16 2Z" stroke="white" strokeWidth="2.5" fill="rgba(255,255,255,0.2)" />
                <circle cx="16" cy="14" r="4" fill="white" />
              </svg>
            </div>
            <h1 style={{ color: 'white', fontSize: '1.75rem', fontWeight: 800, margin: 0, letterSpacing: '-0.02em' }}>TelePoint</h1>
            <p style={{ color: 'rgba(255,255,255,0.8)', fontSize: '0.75rem', marginTop: '0.2rem', letterSpacing: '0.12em', textTransform: 'uppercase' }}>EMI Payment Receipt</p>
          </div>

          {/* Status strip */}
          <div style={{ background: sm.bg, borderBottom: `2px solid ${sm.border}`, padding: '0.75rem 2rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.8rem', color: sm.color, fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              {sm.emoji} {sm.label}
            </span>
            <span style={{ fontFamily: 'DM Mono, monospace', fontSize: '0.7rem', color: sm.color }}>
              #{params.id.slice(0, 8).toUpperCase()}
            </span>
          </div>

          {/* Body */}
          <div style={{ padding: '1.5rem 2rem' }}>

            {/* Customer */}
            <Section title="CUSTOMER">
              <KV label="Name" value={customer?.customer_name} bold />
              {customer?.father_name && <KV label="Father / C/O" value={customer.father_name} />}
              <KV label="Mobile" value={customer?.mobile} mono />
              {customer?.model_no && <KV label="Device" value={customer.model_no} />}
              <KV label="IMEI" value={customer?.imei} mono small />
            </Section>

            {/* Retailer */}
            <Section title="RETAILER">
              <KV label="Name" value={retailer?.name} bold />
              {retailer?.mobile && <KV label="Mobile" value={retailer.mobile} mono />}
              {retailer?.username && <KV label="Retailer ID" value={`@${retailer.username}`} mono small />}
            </Section>

            {/* Payment breakdown */}
            <Section title="PAYMENT BREAKDOWN">
              {items.map(i => (
                <KV key={i.emi_no} label={`EMI #${i.emi_no}`} value={fmt(i.amount)} mono />
              ))}
              {items.length === 0 && (request.total_emi_amount ?? 0) > 0 && (
                <KV label="EMI Amount" value={fmt(request.total_emi_amount)} mono />
              )}
              {(request.first_emi_charge_amount ?? 0) > 0 && (
                <KV label="1st EMI Charge ⭐" value={fmt(request.first_emi_charge_amount)} mono color="#92400e" />
              )}
              {(request.fine_amount ?? 0) > 0 && (
                <KV label="Late Fine ⚠️" value={fmt(request.fine_amount)} mono color="#991b1b" />
              )}
              <div style={{ height: '1px', background: '#e2e8f0', margin: '0.75rem 0' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 800, fontSize: '1rem', color: '#1e293b' }}>Total Paid</span>
                <span style={{ fontFamily: 'DM Mono, monospace', fontWeight: 800, fontSize: '1.5rem', color: '#ca8a04' }}>
                  {fmt(request.total_amount)}
                </span>
              </div>
            </Section>

            {/* Transaction details */}
            <Section title="TRANSACTION DETAILS">
              <KV label="Payment Mode" value={request.mode} bold color={request.mode === 'UPI' ? '#1d4ed8' : '#16a34a'} />
              {request.mode === 'UPI' && (
                <KV label="UPI ID" value="biswajit.khanra82@axl" mono small />
              )}
              <KV label="Collected By" value={retailer?.name ?? '—'} />
              <KV label="Submitted On" value={format(new Date(request.created_at), 'd MMM yyyy, h:mm a')} mono small />
              {request.approved_at && (
                <KV label="Approved On" value={format(new Date(request.approved_at), 'd MMM yyyy, h:mm a')} mono small />
              )}
            </Section>

            {request.notes && (
              <Section title="NOTES">
                <p style={{ fontSize: '0.875rem', color: '#475569', lineHeight: 1.6 }}>{request.notes}</p>
              </Section>
            )}

            {request.rejection_reason && (
              <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: '0.75rem', padding: '0.75rem 1rem', marginBottom: '1rem' }}>
                <p style={{ fontSize: '0.7rem', color: '#991b1b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.25rem' }}>Rejection Reason</p>
                <p style={{ fontSize: '0.875rem', color: '#991b1b' }}>{request.rejection_reason}</p>
              </div>
            )}

            {/* Footer */}
            <div style={{ textAlign: 'center', paddingTop: '1rem', borderTop: '1px dashed #e2e8f0' }}>
              <p style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                TelePoint EMI Portal · Thank you for your payment
              </p>
              <p style={{ fontSize: '0.65rem', color: '#cbd5e1', fontFamily: 'DM Mono, monospace', marginTop: '0.2rem' }}>
                {format(new Date(request.created_at), 'd MMMM yyyy')}
              </p>
            </div>
          </div>
        </div>

        <p style={{ textAlign: 'center', fontSize: '0.7rem', color: '#94a3b8', marginTop: '1.5rem' }}>Created by DIP</p>
      </div>

      <style>{`@media print { #no-print { display: none !important; } body { background: white; } }`}</style>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <p style={{ fontSize: '0.65rem', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.6rem' }}>
        {title}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>{children}</div>
    </div>
  );
}

function KV({ label, value, bold, mono, small, color }: { label: string; value?: string | null; bold?: boolean; mono?: boolean; small?: boolean; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
      <span style={{ fontSize: '0.8rem', color: '#64748b', flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: small ? '0.72rem' : '0.875rem',
        fontWeight: bold ? 700 : 500,
        fontFamily: mono ? 'DM Mono, monospace' : 'inherit',
        color: color ?? '#1e293b',
        textAlign: 'right',
        wordBreak: 'break-all',
      }}>{value ?? '—'}</span>
    </div>
  );
}
