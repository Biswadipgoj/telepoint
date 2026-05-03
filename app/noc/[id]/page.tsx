export const dynamic = 'force-dynamic';
import React from 'react';
import { createClient } from '@/lib/supabase/server';
import { format } from 'date-fns';
import { notFound, redirect } from 'next/navigation';
import PrintButton from '@/components/PrintButton';

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(n);
}

export default async function NOCPage({ params, searchParams }: {
  params: { id: string };
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
  if (profile?.role !== 'super_admin') {
    return (
      <div style={{ minHeight:'100vh', background:'#f8fafc', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <div style={{ background:'rgba(255,255,255,0.05)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:'1rem', padding:'3rem', textAlign:'center', maxWidth:'360px' }}>
          <p style={{ fontSize:'3rem', margin:'0 0 1rem' }}>🚫</p>
          <h1 style={{ color:'white', fontFamily:'Georgia,serif', marginBottom:'0.5rem' }}>Access Denied</h1>
          <p style={{ color:'#94a3b8', fontSize:'0.875rem' }}>Only Admin can generate NOC/Bill documents.</p>
          <a href="/admin" style={{ marginTop:'1.5rem', display:'inline-block', color:'#e8b800', fontSize:'0.875rem' }}>← Back to Dashboard</a>
        </div>
      </div>
    );
  }

  const docType = searchParams?.type === 'bill' ? 'BILL' : 'NOC';

  const { data: customer } = await supabase
    .from('customers')
    .select('*, retailer:retailers(name, username)')
    .eq('id', params.id)
    .single();

  if (!customer) notFound();

  const { data: breakdown } = await supabase.rpc('get_due_breakdown', { p_customer_id: params.id });
  const fineDue = breakdown?.fine_due ?? 0;

  if (docType === 'NOC' && fineDue > 0) {
    return (
      <div style={{ minHeight:'100vh', background:'#f8fafc', display:'flex', alignItems:'center', justifyContent:'center', padding:'2rem' }}>
        <div style={{ background:'rgba(239,68,68,0.08)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:'1rem', padding:'3rem', textAlign:'center', maxWidth:'400px' }}>
          <p style={{ fontSize:'3rem', marginBottom:'1rem' }}>⛔</p>
          <h1 style={{ color:'white', fontFamily:'Georgia,serif', fontSize:'1.75rem', marginBottom:'0.5rem' }}>NOC Blocked</h1>
          <p style={{ color:'#94a3b8', marginBottom:'1.5rem', fontSize:'0.9rem' }}>Cannot generate NOC while a late fine is outstanding.</p>
          <div style={{ background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.2)', borderRadius:'0.75rem', padding:'1rem', marginBottom:'1.5rem' }}>
            <p style={{ color:'#fca5a5', fontWeight:'600' }}>Fine Due: {fmt(fineDue)}</p>
            <p style={{ color:'rgba(252,165,165,0.6)', fontSize:'0.75rem', marginTop:'0.25rem' }}>Waive or collect the fine first, then generate NOC.</p>
          </div>
          <a href="/admin" style={{ color:'#e8b800', fontSize:'0.875rem' }}>← Back to Dashboard</a>
        </div>
      </div>
    );
  }

  const { data: emis } = await supabase
    .from('emi_schedule').select('*').eq('customer_id', params.id).order('emi_no');

  const paidEmis = (emis || []).filter(e => e.status === 'APPROVED');
  const totalPaid = paidEmis.reduce((s: number, e: {amount: number}) => s + e.amount, 0);
  const retailer = customer.retailer as { name?: string; username?: string } | null;

  return (
    <div style={{ minHeight:'100vh', background:'#f8fafc', padding:'2rem 1rem', fontFamily:'Georgia, serif' }}>
      <div style={{ maxWidth:'720px', margin:'0 auto' }}>

        <div id="no-print" style={{ marginBottom:'1.5rem', display:'flex', gap:'0.75rem', justifyContent:'center' }}>
          <PrintButton />
          <a href={`/noc/${params.id}?type=${docType === 'NOC' ? 'bill' : 'noc'}`}
            style={{ padding:'0.625rem 1.5rem', background:'rgba(100,116,139,0.1)', border:'1px solid #334155', borderRadius:'0.75rem', color:'#64748b', fontSize:'0.875rem', textDecoration:'none' }}>
            Switch to {docType === 'NOC' ? 'Bill / Statement' : 'NOC'}
          </a>
        </div>

        <div style={{ background:'white', border:'2px solid #1e293b', borderRadius:'0.5rem', boxShadow:'0 8px 32px rgba(0,0,0,0.12)' }}>

          {/* Letterhead */}
          <div style={{ background:'#1e293b', padding:'2rem', textAlign:'center', borderBottom:'3px solid #e8b800' }}>
            <h1 style={{ color:'#e8b800', fontSize:'2.2rem', fontWeight:'bold', margin:'0', letterSpacing:'0.12em' }}>TELEPOINT</h1>
            <p style={{ color:'#94a3b8', fontSize:'0.75rem', marginTop:'0.25rem', letterSpacing:'0.1em' }}>EMI MANAGEMENT PORTAL · BISWAJIT POINT</p>
          </div>

          {/* Document type */}
          <div style={{ background:'#f1f5f9', padding:'1rem 2rem', borderBottom:'1px solid #e2e8f0', textAlign:'center' }}>
            <h2 style={{ fontSize:'1.2rem', fontWeight:'bold', margin:'0', color:'#0f172a', letterSpacing:'0.04em' }}>
              {docType === 'NOC' ? 'NO OBJECTION CERTIFICATE (NOC)' : 'EMI PAYMENT BILL / STATEMENT'}
            </h2>
            <p style={{ color:'#64748b', fontSize:'0.72rem', marginTop:'0.2rem' }}>
              Date: {format(new Date(), 'd MMMM yyyy')} &nbsp;·&nbsp; Ref: {customer.imei.slice(-6).toUpperCase()}
            </p>
          </div>

          <div style={{ padding:'2rem' }}>

            <DocSection title="CUSTOMER DETAILS">
              <DocRow label="Name" value={customer.customer_name} bold />
              {customer.father_name && <DocRow label="Father / C/O" value={customer.father_name} />}
              <DocRow label="Mobile" value={customer.mobile} />
              {customer.aadhaar && <DocRow label="Aadhaar" value={`XXXX-XXXX-${customer.aadhaar.slice(-4)}`} />}
              {customer.voter_id && <DocRow label="Voter ID" value={customer.voter_id} />}
              {customer.address && <DocRow label="Address" value={`${customer.address}${customer.landmark ? `, near ${customer.landmark}` : ''}`} />}
            </DocSection>

            <DocSection title="DEVICE INFORMATION">
              {customer.model_no && <DocRow label="Model" value={customer.model_no} bold />}
              <DocRow label="IMEI" value={customer.imei} bold />
              {customer.box_no && <DocRow label="Box No." value={customer.box_no} />}
              <DocRow label="Purchase Date" value={format(new Date(customer.purchase_date), 'd MMMM yyyy')} />
              <DocRow label="Purchase Value" value={fmt(customer.purchase_value)} />
              <DocRow label="Down Payment" value={fmt(customer.down_payment)} />
            </DocSection>

            <DocSection title="EMI SUMMARY">
              <DocRow label="Monthly EMI" value={`${fmt(customer.emi_amount)} × ${customer.emi_tenure} months`} />
              <DocRow label="EMIs Paid" value={`${paidEmis.length} / ${customer.emi_tenure}`} bold />
              <DocRow label="Total Collected" value={fmt(totalPaid + (customer.first_emi_charge_amount || 0))} bold />
              {(customer.first_emi_charge_amount || 0) > 0 && (
                <DocRow label="1st EMI Charge" value={`${fmt(customer.first_emi_charge_amount)} — ${customer.first_emi_charge_paid_at ? 'PAID' : 'PENDING'}`} />
              )}
              <DocRow label="Account Status" value={customer.status} bold />
            </DocSection>

            {/* Payment history for BILL */}
            {docType === 'BILL' && paidEmis.length > 0 && (
              <div style={{ marginBottom:'1.5rem' }}>
                <h3 style={{ fontSize:'0.7rem', fontWeight:'bold', color:'#64748b', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:'0.5rem', paddingBottom:'0.25rem', borderBottom:'1px solid #e2e8f0' }}>PAYMENT HISTORY</h3>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'0.78rem' }}>
                  <thead>
                    <tr style={{ background:'#f1f5f9' }}>
                      {['EMI #','Due Date','Paid On','Amount','Mode'].map(h => (
                        <th key={h} style={{ padding:'0.4rem 0.6rem', border:'1px solid #e2e8f0', textAlign: h === 'Amount' ? 'right' : 'left' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {paidEmis.map((e: {id:string; emi_no:number; due_date:string; paid_at?:string; amount:number; mode?:string}) => (
                      <tr key={e.id}>
                        <td style={{ padding:'0.4rem 0.6rem', border:'1px solid #e2e8f0' }}>#{e.emi_no}</td>
                        <td style={{ padding:'0.4rem 0.6rem', border:'1px solid #e2e8f0', fontFamily:'monospace', fontSize:'0.72rem' }}>{format(new Date(e.due_date), 'd MMM yyyy')}</td>
                        <td style={{ padding:'0.4rem 0.6rem', border:'1px solid #e2e8f0', fontFamily:'monospace', fontSize:'0.72rem' }}>{e.paid_at ? format(new Date(e.paid_at), 'd MMM yyyy') : '—'}</td>
                        <td style={{ padding:'0.4rem 0.6rem', border:'1px solid #e2e8f0', textAlign:'right', fontFamily:'monospace' }}>{fmt(e.amount)}</td>
                        <td style={{ padding:'0.4rem 0.6rem', border:'1px solid #e2e8f0', textAlign:'center', fontSize:'0.7rem', fontWeight:'bold' }}>{e.mode || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {retailer?.name && (
              <DocSection title="SOLD BY">
                <DocRow label="Retailer" value={retailer.name} />
                <DocRow label="Username" value={`@${retailer.username}`} />
              </DocSection>
            )}

            {/* NOC declaration */}
            {docType === 'NOC' && (
              <div style={{ marginTop:'1.5rem', padding:'1.25rem', border:'1px solid #e2e8f0', borderRadius:'0.5rem', background:'#f8fafc' }}>
                <p style={{ fontSize:'0.85rem', color:'#1e293b', lineHeight:'1.8', textAlign:'justify' }}>
                  This is to certify that <strong>{customer.customer_name}</strong>
                  {customer.father_name ? `, S/o ${customer.father_name},` : ','} has successfully completed all EMI
                  payments for the device <strong>{customer.model_no || 'Mobile Handset'}</strong> bearing IMEI No.{' '}
                  <strong>{customer.imei}</strong>, purchased from TelePoint on{' '}
                  <strong>{format(new Date(customer.purchase_date), 'd MMMM yyyy')}</strong>.
                  All <strong>{paidEmis.length}</strong> instalments of <strong>{fmt(customer.emi_amount)}</strong> each have been duly received
                  and the account is now fully settled. TelePoint hereby raises no objection to the complete and
                  absolute ownership of the said device by the above-named individual.
                </p>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'2rem', marginTop:'3rem' }}>
                  <div style={{ textAlign:'center', borderTop:'1px solid #94a3b8', paddingTop:'0.5rem' }}>
                    <p style={{ fontSize:'0.72rem', color:'#64748b', margin:0 }}>Authorized Signature</p>
                    <p style={{ fontSize:'0.72rem', color:'#64748b', fontWeight:'bold' }}>TelePoint</p>
                  </div>
                  <div style={{ textAlign:'center', borderTop:'1px solid #94a3b8', paddingTop:'0.5rem' }}>
                    <p style={{ fontSize:'0.72rem', color:'#64748b', margin:0 }}>Customer Signature</p>
                    <p style={{ fontSize:'0.72rem', color:'#64748b', fontWeight:'bold' }}>{customer.customer_name}</p>
                  </div>
                </div>
              </div>
            )}

            <div style={{ marginTop:'2rem', paddingTop:'1rem', borderTop:'1px solid #e2e8f0', textAlign:'center' }}>
              <p style={{ fontSize:'0.68rem', color:'#94a3b8' }}>Generated by TelePoint EMI Portal · {format(new Date(), 'd MMMM yyyy, h:mm a')}</p>
            </div>
          </div>
        </div>
      </div>
      <style>{`@media print { #no-print { display: none !important; } }`}</style>
    </div>
  );
}

function DocSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom:'1.5rem' }}>
      <h3 style={{ fontSize:'0.68rem', fontWeight:'bold', color:'#64748b', textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:'0.5rem', paddingBottom:'0.25rem', borderBottom:'1px solid #e2e8f0' }}>{title}</h3>
      <div style={{ display:'grid', gridTemplateColumns:'180px 1fr', gap:'0.2rem 1rem' }}>{children}</div>
    </div>
  );
}
function DocRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <>
      <p style={{ fontSize:'0.75rem', color:'#64748b', margin:'0.12rem 0' }}>{label}</p>
      <p style={{ fontSize:'0.8rem', color:'#0f172a', margin:'0.12rem 0', fontWeight: bold ? 'bold' : 'normal' }}>{value}</p>
    </>
  );
}
