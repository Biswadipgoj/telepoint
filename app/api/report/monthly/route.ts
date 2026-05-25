import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { calculateSingleEmiFine } from '@/lib/fineCalc';
import { buildCsv, csvHeaders } from '@/lib/csv';
import {
  formatPaymentDateIST,
  formatShortDateIST,
  istMonthRange,
  toISTDateString,
} from '@/lib/ist';

// ── Spec ────────────────────────────────────────────────────────────────────
// Monthly Sheet (per the requirements doc):
//   • Strictly current/selected month — show only the EMI + Fine due that month
//     for RUNNING customers.
//   • Group rows by Retailer.
//   • Within each retailer's group, sort customers chronologically by EMI Date.
//   • Columns: IMEI NO, SR NO., CUST NAME, CUSTOMER NUMBER, ALTARNET NUMBER,
//     1st EMI, Date, EMI Amount, 1st emi charge, remarks.
//   • All date math IST-aware.

const HEADER = [
  'IMEI NO',
  'SR NO.',
  'CUST NAME',
  'CUSTOMER NUMBER',
  'ALTARNET NUMBER',
  '1st EMI',
  'Date',
  'EMI Amount',
  '1st emi charge',
  'remarks',
];

interface CustomerRow {
  id: string;
  retailer_id: string;
  customer_name: string;
  mobile: string;
  alternate_number_1?: string;
  imei: string;
  emi_amount: number;
  first_emi_charge_amount: number;
  first_emi_charge_paid_at?: string;
  status: string;
}

interface EmiRow {
  id: string;
  customer_id: string;
  emi_no: number;
  due_date: string;
  amount: number;
  status: string;
  partial_paid_amount?: number;
  fine_amount: number;
  fine_waived?: boolean;
  fine_paid_amount?: number;
  paid_at?: string;
  mode?: string;
  utr?: string;
}

interface PaymentRow {
  customer_id: string;
  total_emi_amount: number;
  fine_amount: number;
  first_emi_charge_amount: number;
  mode?: string;
  utr?: string;
  approved_at?: string;
  notes?: string;
}

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
  const isAdmin = profile?.role === 'super_admin';
  const isRetailer = profile?.role === 'retailer';
  if (!isAdmin && !isRetailer) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const svc = createServiceClient();

  const now = new Date();
  const { searchParams } = req.nextUrl;
  const month = parseInt(searchParams.get('month') || String(now.getUTCMonth() + 1));
  const year = parseInt(searchParams.get('year') || String(now.getUTCFullYear()));

  const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const monthLabel = `${MONTHS[month - 1]}_${year}`;

  // IST-bounded month window — used both for "EMIs due this month" and
  // "payments collected this month".
  const { startUtc, endUtc } = istMonthRange(year, month);
  const startDate = toISTDateString(startUtc);
  const endDate = toISTDateString(endUtc);

  // ── Retailer scope ──────────────────────────────────────────────────────
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

  const rows: Array<Record<string, unknown> | string> = [];

  for (const retailer of retailers) {
    // Only RUNNING customers are part of the monthly collection sheet.
    const { data: customers } = await svc
      .from('customers')
      .select('id, retailer_id, customer_name, mobile, alternate_number_1, imei, emi_amount, first_emi_charge_amount, first_emi_charge_paid_at, status')
      .eq('retailer_id', retailer.id)
      .eq('status', 'RUNNING');

    const customerList = (customers as CustomerRow[] | null) ?? [];
    if (!customerList.length) continue;

    const custIds = customerList.map(c => c.id);

    const { data: emiRows } = await svc
      .from('emi_schedule')
      .select('id, customer_id, emi_no, due_date, amount, status, partial_paid_amount, fine_amount, fine_waived, fine_paid_amount, paid_at, mode, utr')
      .in('customer_id', custIds);
    const allEmis = (emiRows as EmiRow[] | null) ?? [];

    const { data: paymentRows } = await svc
      .from('payment_requests')
      .select('customer_id, total_emi_amount, fine_amount, first_emi_charge_amount, mode, utr, approved_at, notes')
      .in('customer_id', custIds)
      .eq('status', 'APPROVED')
      .gte('approved_at', startUtc)
      .lte('approved_at', endUtc);
    const payments = (paymentRows as PaymentRow[] | null) ?? [];

    // ── Per-customer evaluation ───────────────────────────────────────────
    interface Eligible {
      customer: CustomerRow;
      monthlyEmi: EmiRow | undefined; // the EMI whose due_date falls in this month
      sortDate: string;               // due date used for chronological sort
      emiAmount: number;
      fineDue: number;
      firstChargeDue: number;
      payments: PaymentRow[];
    }

    const eligible: Eligible[] = [];
    for (const c of customerList) {
      const custEmis = allEmis
        .filter(e => e.customer_id === c.id)
        .sort((a, b) => a.emi_no - b.emi_no);

      // EMI for THIS month — the row whose due_date is in [startDate, endDate].
      const monthlyEmi = custEmis.find(e => {
        const d = toISTDateString(e.due_date);
        return d >= startDate && d <= endDate;
      });

      // Outstanding fine for this customer that's actionable this month:
      // any unpaid fine on any EMI whose due_date is on or before month end.
      const maxEmiNo = custEmis.length ? Math.max(...custEmis.map(e => e.emi_no)) : 0;
      let fineDue = 0;
      for (const e of custEmis) {
        if (e.fine_waived) continue;
        const dueIst = toISTDateString(e.due_date);
        if (dueIst > endDate) continue;
        const isOverdueUnpaid = ['UNPAID', 'PARTIALLY_PAID'].includes(e.status) && dueIst < startDate
          ? true
          : ['UNPAID', 'PARTIALLY_PAID'].includes(e.status) && dueIst <= endDate;
        const storedFine = Number(e.fine_amount || 0);
        const finePaid = Number(e.fine_paid_amount || 0);
        const storedUnpaid = storedFine > 0 && finePaid < storedFine;
        if (!isOverdueUnpaid && !storedUnpaid) continue;
        const isLastEmiUnpaid = e.emi_no === maxEmiNo && e.status !== 'APPROVED';
        const live = calculateSingleEmiFine(e.due_date, isLastEmiUnpaid);
        const effective = Math.max(live, storedFine);
        fineDue += Math.max(0, effective - finePaid);
      }

      const firstChargeDue =
        Number(c.first_emi_charge_amount) > 0 && !c.first_emi_charge_paid_at
          ? Number(c.first_emi_charge_amount)
          : 0;

      // Skip customers with absolutely nothing actionable this month.
      const hasMonthlyEmi = !!monthlyEmi && monthlyEmi.status !== 'APPROVED';
      if (!hasMonthlyEmi && fineDue === 0 && firstChargeDue === 0) continue;

      const monthPayments = payments.filter(p => p.customer_id === c.id);

      const sortDate = monthlyEmi
        ? toISTDateString(monthlyEmi.due_date)
        : (custEmis.find(e => ['UNPAID', 'PARTIALLY_PAID'].includes(e.status))?.due_date ?? '9999-12-31');

      eligible.push({
        customer: c,
        monthlyEmi,
        sortDate,
        emiAmount: monthlyEmi
          ? Math.max(0, Number(monthlyEmi.amount || 0) - Number(monthlyEmi.partial_paid_amount || 0))
          : 0,
        fineDue,
        firstChargeDue,
        payments: monthPayments,
      });
    }

    if (!eligible.length) continue;

    // Chronological sort within retailer block.
    eligible.sort((a, b) => a.sortDate.localeCompare(b.sortDate));

    // Retailer banner row.
    rows.push(`,,"★ ${retailer.name.toUpperCase()} — ${MONTHS[month - 1]} ${year} ★",,,,,,,`);

    let sr = 0;
    for (const e of eligible) {
      sr += 1;
      const c = e.customer;
      const remarks: string[] = [];
      for (const p of e.payments) {
        if (p.approved_at) remarks.push(formatPaymentDateIST(p.approved_at));
        if (p.utr) remarks.push(p.utr);
        const parts: string[] = [];
        if (Number(p.total_emi_amount) > 0) parts.push(`EMI:${Number(p.total_emi_amount)}`);
        if (Number(p.fine_amount) > 0) parts.push(`Fine:${Number(p.fine_amount)}`);
        if (Number(p.first_emi_charge_amount) > 0) parts.push(`Chg:${Number(p.first_emi_charge_amount)}`);
        if (parts.length) remarks.push(parts.join('+'));
      }
      if (e.fineDue > 0) remarks.push(`FINE DUE ₹${Math.round(e.fineDue)}`);
      if (e.firstChargeDue > 0) remarks.push(`1ST CHARGE DUE ₹${Math.round(e.firstChargeDue)}`);

      rows.push({
        'IMEI NO': "'" + (c.imei || ''),
        'SR NO.': sr,
        'CUST NAME': c.customer_name,
        'CUSTOMER NUMBER': c.mobile,
        'ALTARNET NUMBER': c.alternate_number_1 ?? '',
        '1st EMI': e.monthlyEmi ? formatShortDateIST(e.monthlyEmi.due_date) : '',
        'Date': e.monthlyEmi ? formatShortDateIST(e.monthlyEmi.due_date) : '',
        'EMI Amount': e.emiAmount > 0 ? e.emiAmount : '',
        '1st emi charge': e.firstChargeDue > 0 ? e.firstChargeDue : '',
        'remarks': remarks.join(' | '),
      });
    }
  }

  if (rows.length === 0) {
    // Still return a valid (header-only) CSV instead of a 404.
    const csv = buildCsv({ header: HEADER, rows: [] });
    return new NextResponse(csv, { headers: csvHeaders(`TelePoint_Collection_${monthLabel}.csv`) });
  }

  const csv = buildCsv({ header: HEADER, rows });
  return new NextResponse(csv, {
    headers: csvHeaders(`TelePoint_Collection_${monthLabel}.csv`),
  });
}
