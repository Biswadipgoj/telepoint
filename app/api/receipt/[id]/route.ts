import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
  }).format(n);
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDateShort(d: string) {
  return new Date(d).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const serviceClient = createServiceClient();

  const { data: request, error } = await serviceClient
    .from('payment_requests')
    .select(`
      *,
      customer:customers(
        id, customer_name, customer_photo_url, mobile,
        retailer:retailers(name, mobile)
      ),
      retailer:retailers(name, mobile),
      items:payment_request_items(emi_no, amount)
    `)
    .eq('id', params.id)
    .single();

  if (error || !request) {
    return new NextResponse('Receipt not found', { status: 404 });
  }

  const customer = request.customer as {
    id?: string;
    customer_name?: string;
    customer_photo_url?: string;
    mobile?: string;
    retailer?: { name?: string; mobile?: string };
  } | null;

  const retailer = request.retailer as {
    name?: string;
    mobile?: string;
  } | null;

  const items = (request.items as { emi_no: number; amount: number }[]) ?? [];

  // Fetch next unpaid EMI for this customer
  let nextEmiDueDate: string | null = null;
  if (customer?.id) {
    const { data: nextEmi } = await serviceClient
      .from('emi_schedule')
      .select('due_date')
      .eq('customer_id', customer.id)
      .eq('status', 'UNPAID')
      .order('emi_no', { ascending: true })
      .limit(1)
      .single();
    nextEmiDueDate = nextEmi?.due_date ?? null;
  }

  const statusColors: Record<string, string> = {
    PENDING: '#92400e',
    APPROVED: '#1d4ed8',
    REJECTED: '#991b1b',
  };
  const statusBgs: Record<string, string> = {
    PENDING: '#fef3c7',
    APPROVED: '#dbeafe',
    REJECTED: '#fee2e2',
  };
  const statusLabels: Record<string, string> = {
    PENDING: '⏳ Pending Approval',
    APPROVED: '✅ Approved',
    REJECTED: '❌ Rejected',
  };

  const status = request.status as string;
  const statusColor = statusColors[status] ?? '#374151';
  const statusBg = statusBgs[status] ?? '#f9fafb';
  const statusLabel = statusLabels[status] ?? status;

  const emiAmount = Number(request.total_emi_amount ?? 0);
  const fineAmount = Number(request.fine_amount ?? 0);
  const firstEmiCharge = Number(request.first_emi_charge_amount ?? 0);
  const totalAmount = Number(request.total_amount ?? 0);

  // Customer photo — handle IBB and direct URLs
  const photoUrl = customer?.customer_photo_url ?? '';
  const photoHtml = photoUrl
    ? `<img src="${photoUrl}" alt="Customer Photo" style="width:80px;height:80px;border-radius:12px;object-fit:cover;border:2px solid #e2e8f0;display:block;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
       <div style="display:none;width:80px;height:80px;border-radius:12px;background:#f1f5f9;border:2px solid #e2e8f0;align-items:center;justify-content:center;color:#94a3b8;font-size:0.7rem;text-align:center;">No<br>Photo</div>`
    : `<div style="width:80px;height:80px;border-radius:12px;background:#f1f5f9;border:2px solid #e2e8f0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:0.7rem;text-align:center;">No<br>Photo</div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Receipt #${params.id.slice(0, 8).toUpperCase()}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8fafc; padding: 1.5rem 1rem; color: #1e293b; }
    .receipt { max-width: 420px; margin: 0 auto; background: white; border-radius: 1.5rem; overflow: hidden; box-shadow: 0 8px 40px rgba(0,0,0,0.12); border: 1px solid #e2e8f0; }
    .header { background: linear-gradient(135deg, #eab308 0%, #ca8a04 100%); padding: 1.5rem; text-align: center; color: white; }
    .header h1 { font-size: 1.5rem; font-weight: 800; }
    .header p { font-size: 0.7rem; opacity: 0.8; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 0.2rem; }
    .status-bar { padding: 0.6rem 1.25rem; background: ${statusBg}; border-bottom: 2px solid ${statusColor}40; display: flex; justify-content: space-between; align-items: center; }
    .status-label { font-weight: 700; font-size: 0.8rem; color: ${statusColor}; }
    .receipt-id { font-family: monospace; font-size: 0.65rem; color: ${statusColor}; }
    .body { padding: 1.25rem; }
    .customer-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.25rem; padding-bottom: 1rem; border-bottom: 1px solid #e2e8f0; }
    .kv { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 0.45rem; }
    .kv-label { font-size: 0.78rem; color: #64748b; flex-shrink: 0; }
    .kv-value { font-size: 0.85rem; font-weight: 500; text-align: right; color: #1e293b; }
    .kv-value.bold { font-weight: 700; }
    .kv-value.mono { font-family: monospace; font-size: 0.78rem; }
    .section-title { font-size: 0.6rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.12em; margin: 0.9rem 0 0.5rem; }
    .divider { height: 1px; background: #e2e8f0; margin: 0.6rem 0; }
    .total-row { display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem; }
    .total-label { font-weight: 800; font-size: 0.95rem; }
    .total-value { font-family: monospace; font-weight: 800; font-size: 1.3rem; color: #ca8a04; }
    .next-emi { background: #f0fdf4; border: 1px solid #86efac; border-radius: 0.6rem; padding: 0.6rem 0.75rem; margin-top: 0.9rem; }
    .next-emi p { font-size: 0.75rem; color: #16a34a; font-weight: 600; }
    .next-emi span { font-size: 0.7rem; color: #166534; }
    .footer { text-align: center; padding-top: 0.75rem; border-top: 1px dashed #e2e8f0; margin-top: 0.75rem; }
    .footer p { font-size: 0.65rem; color: #94a3b8; }
    @media print { body { background: white; padding: 0; } .receipt { box-shadow: none; border: none; } .no-print { display: none !important; } }
  </style>
</head>
<body>
  <div class="no-print" style="max-width:420px;margin:0 auto 1rem;display:flex;gap:0.5rem;justify-content:center;">
    <button onclick="window.print()" style="padding:0.5rem 1rem;background:#eab308;color:white;border:none;border-radius:0.6rem;font-size:0.8rem;font-weight:600;cursor:pointer;">🖨️ Print</button>
  </div>
  <div class="receipt">
    <div class="header">
      <h1>TelePoint</h1>
      <p>EMI Payment Receipt</p>
    </div>
    <div class="status-bar">
      <span class="status-label">${statusLabel}</span>
      <span class="receipt-id">#${params.id.slice(0, 8).toUpperCase()}</span>
    </div>
    <div class="body">
      <div class="customer-row">
        ${photoHtml}
        <div>
          <p style="font-weight:700;font-size:0.95rem;">${customer?.customer_name ?? '—'}</p>
          <p style="font-size:0.78rem;color:#64748b;margin-top:0.2rem;">${retailer?.name ?? '—'}</p>
          ${retailer?.mobile ? `<p style="font-size:0.72rem;color:#94a3b8;font-family:monospace;">${retailer.mobile}</p>` : ''}
        </div>
      </div>

      <div class="section-title">Payment Breakdown</div>
      ${items.map(i => `<div class="kv"><span class="kv-label">EMI #${i.emi_no} collected</span><span class="kv-value mono">${fmt(i.amount)}</span></div>`).join('')}
      ${items.length === 0 && emiAmount > 0 ? `<div class="kv"><span class="kv-label">EMI collected</span><span class="kv-value mono">${fmt(emiAmount)}</span></div>` : ''}
      ${fineAmount > 0 ? `<div class="kv"><span class="kv-label" style="color:#991b1b;">Fine paid ⚠️</span><span class="kv-value mono" style="color:#991b1b;">${fmt(fineAmount)}</span></div>` : ''}
      ${firstEmiCharge > 0 ? `<div class="kv"><span class="kv-label" style="color:#92400e;">1st EMI Charge ⭐</span><span class="kv-value mono" style="color:#92400e;">${fmt(firstEmiCharge)}</span></div>` : ''}
      <div class="divider"></div>
      <div class="total-row"><span class="total-label">Total Paid</span><span class="total-value">${fmt(totalAmount)}</span></div>

      <div class="section-title">Transaction</div>
      <div class="kv"><span class="kv-label">Payment Mode</span><span class="kv-value bold" style="color:${request.mode === 'UPI' ? '#1d4ed8' : '#16a34a'};">${request.mode}</span></div>
      <div class="kv"><span class="kv-label">Date & Time</span><span class="kv-value mono" style="font-size:0.72rem;">${fmtDate(request.created_at)}</span></div>
      <div class="kv"><span class="kv-label">Status</span><span class="kv-value bold" style="color:${statusColor};">${statusLabel}</span></div>
      ${request.approved_at ? `<div class="kv"><span class="kv-label">Approved</span><span class="kv-value mono" style="font-size:0.72rem;">${fmtDate(request.approved_at)}</span></div>` : ''}

      ${nextEmiDueDate
        ? `<div class="next-emi"><p>📅 Next EMI Due</p><span>${fmtDateShort(nextEmiDueDate)}</span></div>`
        : `<div class="next-emi" style="background:#eff6ff;border-color:#93c5fd;"><p style="color:#1d4ed8;">✅ No Further EMI Due</p><span style="color:#1e40af;">All EMIs completed</span></div>`
      }

      ${request.rejection_reason ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:0.6rem;padding:0.6rem 0.75rem;margin-top:0.75rem;"><p style="font-size:0.65rem;color:#991b1b;font-weight:700;text-transform:uppercase;margin-bottom:0.2rem;">Rejection Reason</p><p style="font-size:0.8rem;color:#991b1b;">${request.rejection_reason}</p></div>` : ''}

      <div class="footer">
        <p>TelePoint EMI Portal · Thank you</p>
        <p style="margin-top:0.15rem;font-family:monospace;font-size:0.6rem;color:#cbd5e1;">${new Date(request.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
      </div>
    </div>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `inline; filename="receipt-${params.id.slice(0, 8)}.html"`,
      'Cache-Control': 'no-store',
    },
  });
}


