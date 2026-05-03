import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { calculateSingleEmiFine } from '@/lib/fineCalc';

// ── IST offset helper ─────────────────────────────────────────────────────────
const IST_MS = 5.5 * 60 * 60 * 1000;

function toIST(d: Date): Date {
  return new Date(d.getTime() + IST_MS);
}

function fmtDateShort(iso: string): string {
  // Parse as UTC date-string or timestamp → display in IST
  try {
    const d = toIST(new Date(iso));
    const day   = String(d.getUTCDate()).padStart(2, '0');
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
    const yr    = String(d.getUTCFullYear()).slice(-2);
    return `${day}-${month}-${yr}`;
  } catch { return iso; }
}

function fmtPaymentDate(iso: string): string {
  try {
    const d = toIST(new Date(iso));
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yr = String(d.getUTCFullYear()).slice(-2);
    return `${dd}.${mm}.${yr}`;
  } catch { return ''; }
}

function csv(val: string): string {
  const s = String(val ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

export async function GET(req: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
  const isAdmin    = profile?.role === 'super_admin';
  const isRetailer = profile?.role === 'retailer';
  if (!isAdmin && !isRetailer) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const svc = createServiceClient();

  // ── Params ─────────────────────────────────────────────────────────────────
  const { searchParams } = req.nextUrl;
  const month = parseInt(searchParams.get('month') || String(new Date().getMonth() + 1));
  const year  = parseInt(searchParams.get('year')  || String(new Date().getFullYear()));

  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const monthLabel = `${MONTHS[month - 1]}'${String(year).slice(-2)}`;

  // IST-aware month window in UTC
  const monthStart = new Date(Date.UTC(year, month - 1, 1) - IST_MS);
  const monthEnd   = new Date(Date.UTC(year, month,     0, 23, 59, 59, 999) - IST_MS);

  // ── Scope to role ──────────────────────────────────────────────────────────
  let retailers: { id: string; name: string }[] = [];
  if (isAdmin) {
    const { data } = await svc.from('retailers').select('id, name').eq('is_active', true).order('name');
    retailers = data || [];
  } else {
    const { data } = await svc.from('retailers').select('id, name').eq('auth_user_id', user.id).single();
    if (!data) return NextResponse.json({ error: 'Retailer not found' }, { status: 403 });
    retailers = [data];
  }

  if (!retailers.length) return NextResponse.json({ error: 'No retailers found' }, { status: 404 });

  // ── Build CSV rows ─────────────────────────────────────────────────────────
  const rows: string[] = [];

  for (const retailer of retailers) {
    // Retailer customers (RUNNING, COMPLETE, NPA)
    const { data: customers } = await svc
      .from('customers')
      .select('id, customer_name, mobile, alternate_number_1, imei, emi_due_day, emi_amount, first_emi_charge_amount, first_emi_charge_paid_at, status')
      .eq('retailer_id', retailer.id)
      .in('status', ['RUNNING', 'COMPLETE', 'NPA'])
      .order('emi_due_day')
      .order('customer_name');

    if (!customers?.length) continue;

    const custIds = customers.map(c => c.id);

    // EMI schedule for all customers
    const { data: allEmis } = await svc
      .from('emi_schedule')
      .select('id, customer_id, emi_no, due_date, amount, status, paid_at, mode, utr, fine_amount, fine_paid_amount, fine_paid_at')
      .in('customer_id', custIds)
      .order('emi_no');

    // Approved payments this month
    const { data: payments } = await svc
      .from('payment_requests')
      .select('customer_id, total_emi_amount, fine_amount, first_emi_charge_amount, mode, utr, approved_at, notes')
      .in('customer_id', custIds)
      .eq('status', 'APPROVED')
      .gte('approved_at', monthStart.toISOString())
      .lte('approved_at', monthEnd.toISOString());

    // ── Retailer header — centre-aligned label + colored marker ──────────────
    // CSV doesn't support colours directly; we use a descriptive marker cell
    // that spreadsheet apps (Excel/Sheets) can be asked to colour manually.
    // We add a blank separator row, then the retailer name row.
    rows.push('');  // blank row separator
    rows.push('');  // extra blank
    // Row with retailer name centered via padding spaces in cell + marker text
    // Column A blank, Column B = center-aligned retailer heading
    const headerCells = [
      '##RETAILER##',   // marker column — tells opener to style this row
      csv(`★ ${retailer.name.toUpperCase()} — EMI COLLECTION SHEET — ${monthLabel} ★`),
      '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    ];
    rows.push(headerCells.join(','));
    rows.push([
      'IMEI NO', 'SR', 'CUSTOMER NAME', 'MOBILE', 'ALTERNATE',
      '1st EMI DATE', 'DUE DAY', 'EMI AMOUNT', '1st EMI CHARGE', 'REMARKS',
      '', '', '', '', '', '',
    ].map(csv).join(','));

    // Sort customers by their first EMI date
    const sorted = [...customers].sort((a, b) => {
      const aEmi = (allEmis || []).filter(e => e.customer_id === a.id)
        .sort((x, y) => new Date(x.due_date).getTime() - new Date(y.due_date).getTime())[0];
      const bEmi = (allEmis || []).filter(e => e.customer_id === b.id)
        .sort((x, y) => new Date(x.due_date).getTime() - new Date(y.due_date).getTime())[0];
      return new Date(aEmi?.due_date || '9999').getTime() - new Date(bEmi?.due_date || '9999').getTime();
    });

    let srNo = 0;
    for (const cust of sorted) {
      srNo++;
      const custEmis = (allEmis || [])
        .filter(e => e.customer_id === cust.id)
        .sort((a, b) => a.emi_no - b.emi_no);

      const firstEmi = custEmis[0];
      const custPmts = (payments || []).filter(p => p.customer_id === cust.id);

      // EMI amount cell — 'CLOSE' if complete
      const emiAmtStr = cust.status === 'COMPLETE' ? 'CLOSE' : String(cust.emi_amount || '');

      // LIVE outstanding fine — uses calculateSingleEmiFine for overdue EMIs
      // This is correct even when fine_amount in DB is 0 (not yet stored)
      const maxEmiNoForCust = custEmis.length > 0
        ? Math.max(...custEmis.map(e => e.emi_no))
        : 0;
      const fineOutstanding = custEmis.reduce((s, e) => {
        if ((e as { fine_waived?: boolean }).fine_waived) return s;
        const isOverdueUnpaid = ['UNPAID', 'PARTIALLY_PAID'].includes(e.status)
          && new Date(e.due_date) < new Date();
        const storedFineUnpaid = Number(e.fine_amount || 0) > 0
          && Number(e.fine_paid_amount || 0) < Number(e.fine_amount || 0);
        if (!isOverdueUnpaid && !storedFineUnpaid) return s;
        const isLast = e.emi_no === maxEmiNoForCust;
        // Live calculation — what the fine ACTUALLY is today
        const liveCalc = calculateSingleEmiFine(e.due_date, isLast);
        // Use the higher of live vs stored (stored may include manual overrides)
        const effective = Math.max(liveCalc, Number(e.fine_amount || 0));
        const finePaid  = Number(e.fine_paid_amount || 0);
        return s + Math.max(0, effective - finePaid);
      }, 0);

      // 1st EMI charge (only if unpaid)
      const chargeStr = Number(cust.first_emi_charge_amount) > 0 && !cust.first_emi_charge_paid_at
        ? String(cust.first_emi_charge_amount)
        : '';

      // Remarks: date + UTR of payments made this month
      const remarks: string[] = [];
      for (const pmt of custPmts) {
        if (pmt.approved_at) remarks.push(fmtPaymentDate(pmt.approved_at));
        if (pmt.utr)         remarks.push(pmt.utr);
        if (Number(pmt.fine_amount) > 0)
          remarks.push(`EMI:${pmt.total_emi_amount}+Fine:${pmt.fine_amount}`);
        if (Number(pmt.first_emi_charge_amount) > 0)
          remarks.push(`Charge:${pmt.first_emi_charge_amount}`);
      }

      const row = [
        "'" + (cust.imei || ''),            // prefix ' to prevent Excel auto-format
        srNo,
        cust.customer_name || '',
        cust.mobile || '',
        cust.alternate_number_1 || '',
        firstEmi ? fmtDateShort(firstEmi.due_date) : '',
        cust.emi_due_day || '',
        emiAmtStr,
        chargeStr,
        remarks.join(' | '),
        '', '', '', '', '', '',
      ].map(v => csv(String(v))).join(',');

      rows.push(row);

      // Fine row — shows OUTSTANDING balance only
      if (fineOutstanding > 0 && cust.status !== 'COMPLETE') {
        rows.push([
          '', '', csv(`${cust.customer_name} (FINE DUE)`), '', '',
          '', '', '', '',
          csv(`Outstanding Fine: ₹${fineOutstanding}`),
          '', '', '', '', '', '',
        ].join(','));
      }
    }
  }

  rows.push('');  // trailing blank

  const csvContent = rows.join('\r\n');
  const filename   = `TelePoint_Collection_${MONTHS[month - 1]}_${year}.csv`;

  return new NextResponse(csvContent, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store, no-cache',
    },
  });
}
