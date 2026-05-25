import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0 }).format(n);
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const svc = createServiceClient();
  const { data: customer } = await svc
    .from('customers')
    .select('*, retailer:retailers(name, mobile)')
    .eq('id', params.id)
    .single();

  if (!customer || customer.status !== 'SETTLED') {
    return new NextResponse('Settlement letter not available', { status: 404 });
  }

  const retailer = customer.retailer as { name?: string; mobile?: string } | null;

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Settlement Letter - ${customer.customer_name}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:Georgia,serif;background:#f8fafc;padding:2rem 1rem;color:#1e293b}
  .letter{max-width:600px;margin:0 auto;background:white;border:2px solid #e2e8f0;border-radius:1rem;overflow:hidden}
  .header{background:linear-gradient(135deg,#eab308,#ca8a04);padding:2rem;text-align:center;color:white}
  .header h1{font-size:1.5rem;font-weight:800}
  .body{padding:2rem}
  .warn{background:#fef3c7;border:2px solid #f59e0b;border-radius:.75rem;padding:1rem;margin:1.5rem 0;text-align:center}
  .warn p{color:#92400e;font-weight:700;font-size:1rem}
  .kv{display:flex;justify-content:space-between;margin:.4rem 0;font-size:.9rem}
  .kv span:last-child{font-weight:600}
  .divider{height:1px;background:#e2e8f0;margin:1rem 0}
  .footer{text-align:center;padding-top:1.5rem;border-top:1px dashed #e2e8f0;margin-top:1.5rem}
  @media print{body{background:white;padding:0}.letter{border:none;box-shadow:none}}
  .no-print{text-align:center;margin-bottom:1rem}
</style></head><body>
<div class="no-print"><button onclick="window.print()" style="padding:.5rem 1.5rem;background:#eab308;color:white;border:none;border-radius:.5rem;font-weight:600;cursor:pointer">Print</button></div>
<div class="letter">
  <div class="header">
    <h1>TelePoint</h1>
    <p style="opacity:.8;font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;margin-top:.25rem">Settlement Letter</p>
  </div>
  <div class="body">
    <div class="warn">
      <p>⚠️ EMI SETTLED</p>
      <p style="font-size:.8rem;font-weight:400;margin-top:.25rem">This account was closed via settlement</p>
    </div>

    <p style="font-size:.85rem;color:#64748b;margin-bottom:1rem">Date: ${fmtDate(customer.settlement_date || customer.completion_date || new Date().toISOString())}</p>

    <div class="kv"><span>Customer Name</span><span>${customer.customer_name}</span></div>
    ${customer.father_name ? `<div class="kv"><span>Father / C/O</span><span>${customer.father_name}</span></div>` : ''}
    <div class="kv"><span>Mobile</span><span>${customer.mobile}</span></div>
    <div class="kv"><span>IMEI</span><span style="font-family:monospace;font-size:.8rem">${customer.imei}</span></div>
    ${customer.model_no ? `<div class="kv"><span>Device</span><span>${customer.model_no}</span></div>` : ''}
    <div class="kv"><span>Retailer</span><span>${retailer?.name || '—'}</span></div>

    <div class="divider"></div>

    <div class="kv"><span>Purchase Value</span><span>${fmt(customer.purchase_value)}</span></div>
    <div class="kv"><span>Down Payment</span><span>${fmt(customer.down_payment)}</span></div>
    <div class="kv"><span>Loan Amount</span><span>${fmt(customer.disburse_amount || customer.purchase_value - customer.down_payment)}</span></div>
    <div class="kv"><span>EMI Amount</span><span>${fmt(customer.emi_amount)} × ${customer.emi_tenure} months</span></div>

    <div class="divider"></div>

    <div class="kv" style="font-size:1.1rem"><span style="font-weight:800">Settlement Amount</span><span style="color:#ca8a04;font-weight:800;font-size:1.3rem">${fmt(customer.settlement_amount)}</span></div>

    <div class="divider"></div>

    <p style="font-size:.85rem;line-height:1.7;color:#475569;margin-top:1rem">
      This is to certify that the EMI account for the above-mentioned customer has been settled for a total amount of
      <strong>${fmt(customer.settlement_amount)}</strong> as on ${fmtDate(customer.settlement_date || customer.completion_date || new Date().toISOString())}.
      All remaining EMI obligations are considered closed. TelePoint acknowledges receipt of the settlement amount
      and confirms no further dues remain on this account.
    </p>

    <div class="footer">
      <p style="font-size:.75rem;color:#94a3b8">TelePoint EMI Portal</p>
      <p style="font-size:.65rem;color:#cbd5e1;margin-top:.25rem">Settlement Ref: ${params.id.slice(0, 8).toUpperCase()}</p>
    </div>
  </div>
</div></body></html>`;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
