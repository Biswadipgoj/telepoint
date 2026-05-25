import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { csvHeaders, csvCell, csvRow } from '@/lib/csv';
import { calculateTotalFineFromEmis } from '@/lib/fineCalc';
import { EMISchedule } from '@/lib/types';

const BOM = '﻿';

const MONTHS_UPPER = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Format YYYY-MM-DD as D-Mon-YY (no leading zero for day, mixed-case month). */
function formatDMonYY(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length < 3) return '';
  const year2 = parts[0].slice(-2);
  const monthIdx = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10); // no leading zero
  if (monthIdx < 0 || monthIdx > 11) return '';
  return `${day}-${MONTHS_SHORT[monthIdx]}-${year2}`;
}

/** Format as MMM'YY for the title (e.g., FEB'26). */
function formatMonthTitle(month: number, year: number): string {
  return `${MONTHS_UPPER[month - 1]}'${String(year).slice(-2)}`;
}

interface CustomerRow {
  id: string;
  customer_name: string;
  mobile: string;
  alternate_number_1?: string | null;
  imei: string;
  emi_amount: number;
  emi_due_day: number;
  emi_tenure: number;
  first_emi_charge_amount?: number | null;
  first_emi_charge_paid_at?: string | null;
}

interface EmiRow {
  customer_id: string;
  emi_no: number;
  due_date: string;
  amount: number;
  status: string;
  fine_amount: number;
  fine_waived: boolean;
  fine_paid_amount: number;
}

function buildEmptySheet(retailerName: string, month: number, year: number): string {
  const title = `${retailerName.toUpperCase()} - EMI COLLECTION SHEET FOR THE MONTH OF ${formatMonthTitle(month, year)}`;
  return [
    BOM + ',,,,,,,,,,,,,,,',
    `${csvCell(title)},,,,,,,,,,,,,,,`,
    'IMEI NO,SR NO.,CUST NAME,CUSTOMER NUMBER,ALTARNET NUMBER,1st EMI,Date,EMI Amount,1st emi charge,remarks,Fine Due,,,,,',
  ].join('\r\n');
}

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single();

  // Every authenticated user must have a profile row
  if (!profile) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const isAdmin = profile.role === 'super_admin';
  const svc = createServiceClient();

  const { searchParams } = new URL(req.url);
  const month = parseInt(searchParams.get('month') ?? '', 10);
  const year = parseInt(searchParams.get('year') ?? '', 10);

  if (!month || !year || month < 1 || month > 12 || year < 2020 || year > 2099) {
    return NextResponse.json({ error: 'Valid month (1-12) and year required' }, { status: 400 });
  }

  // Resolve retailer
  let retailerId: string;
  let retailerName: string;

  if (isAdmin) {
    const paramRetailerId = searchParams.get('retailer_id');
    if (!paramRetailerId) {
      return NextResponse.json({ error: 'retailer_id param required for admin' }, { status: 400 });
    }
    const { data: ret } = await svc
      .from('retailers')
      .select('id, name')
      .eq('id', paramRetailerId)
      .single();
    if (!ret) return NextResponse.json({ error: 'Retailer not found' }, { status: 404 });
    retailerId = ret.id;
    retailerName = ret.name;
  } else {
    const { data: ret } = await svc
      .from('retailers')
      .select('id, name')
      .eq('auth_user_id', user.id)
      .single();
    if (!ret) return NextResponse.json({ error: 'Retailer not found' }, { status: 403 });
    retailerId = ret.id;
    retailerName = ret.name;
  }

  // Month boundaries as YYYY-MM-DD strings (date-only comparison, no timezone needed)
  const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const endOfMonth = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const filename = `collection-${year}-${String(month).padStart(2, '0')}.csv`;

  // Load RUNNING customers for this retailer
  const { data: rawCustomers, error: custErr } = await svc
    .from('customers')
    .select(
      'id, customer_name, mobile, alternate_number_1, imei, emi_amount, emi_due_day, emi_tenure, ' +
      'first_emi_charge_amount, first_emi_charge_paid_at',
    )
    .eq('retailer_id', retailerId)
    .eq('status', 'RUNNING');

  if (custErr) {
    console.error('[collection export] customers query error:', custErr);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const customerList = (rawCustomers as CustomerRow[] | null) ?? [];

  if (customerList.length === 0) {
    return new NextResponse(buildEmptySheet(retailerName, month, year), {
      headers: csvHeaders(filename),
    });
  }

  const customerIds = customerList.map(c => c.id);

  // Load all EMI schedules for these customers
  const { data: rawEmis, error: emiErr } = await svc
    .from('emi_schedule')
    .select('customer_id, emi_no, due_date, amount, status, fine_amount, fine_waived, fine_paid_amount')
    .in('customer_id', customerIds)
    .order('emi_no');

  if (emiErr) {
    console.error('[collection export] emi_schedule query error:', emiErr);
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const emisByCustomer = new Map<string, EmiRow[]>();
  for (const e of (rawEmis as EmiRow[] | null) ?? []) {
    const list = emisByCustomer.get(e.customer_id) ?? [];
    list.push(e);
    emisByCustomer.set(e.customer_id, list);
  }

  // Load fine settings
  const { data: fineSettings } = await svc
    .from('fine_settings')
    .select('default_fine_amount, weekly_fine_increment')
    .eq('id', 1)
    .single();
  const baseFine = Number(fineSettings?.default_fine_amount ?? 450);
  const weeklyIncrement = Number(fineSettings?.weekly_fine_increment ?? 25);

  // Filter: include customers with EMI in selected month OR overdue (UNPAID/PARTIALLY_PAID) from previous months
  const included = customerList.filter(c => {
    const emis = emisByCustomer.get(c.id) ?? [];
    const hasThisMonthEmi = emis.some(e => e.due_date >= startOfMonth && e.due_date <= endOfMonth);
    const hasPrevOverdue = emis.some(
      e => e.due_date < startOfMonth && (e.status === 'UNPAID' || e.status === 'PARTIALLY_PAID'),
    );
    return hasThisMonthEmi || hasPrevOverdue;
  });

  // Sort: by emi_due_day ascending (nulls last), then by first EMI date ascending
  included.sort((a, b) => {
    const dayDiff = (a.emi_due_day ?? 99) - (b.emi_due_day ?? 99);
    if (dayDiff !== 0) return dayDiff;
    const aFirst = (emisByCustomer.get(a.id) ?? []).find(e => e.emi_no === 1)?.due_date ?? '9999-99-99';
    const bFirst = (emisByCustomer.get(b.id) ?? []).find(e => e.emi_no === 1)?.due_date ?? '9999-99-99';
    return aFirst.localeCompare(bFirst);
  });

  // Build CSV rows
  const title = `${retailerName.toUpperCase()} - EMI COLLECTION SHEET FOR THE MONTH OF ${formatMonthTitle(month, year)}`;

  const lines: string[] = [
    BOM + ',,,,,,,,,,,,,,,',
    `${csvCell(title)},,,,,,,,,,,,,,,`,
    'IMEI NO,SR NO.,CUST NAME,CUSTOMER NUMBER,ALTARNET NUMBER,1st EMI,Date,EMI Amount,1st emi charge,remarks,Fine Due,,,,,',
  ];

  let sr = 0;
  for (const c of included) {
    sr += 1;
    const emis = emisByCustomer.get(c.id) ?? [];
    const firstEmi = emis.find(e => e.emi_no === 1);
    const firstEmiDate = firstEmi?.due_date ? formatDMonYY(firstEmi.due_date) : '';

    // Show 1st EMI charge only if not yet paid (use ?? so amount=0 stays visible)
    const firstEmiCharge = c.first_emi_charge_paid_at ? '' : (c.first_emi_charge_amount ?? '');

    // Fine Due: total outstanding fine on ALL overdue EMIs as of today
    const fineDue = calculateTotalFineFromEmis(emis as unknown as EMISchedule[], baseFine, weeklyIncrement);

    lines.push(csvRow([
      c.imei,
      sr,
      c.customer_name,
      c.mobile,
      c.alternate_number_1 ?? '',
      firstEmiDate,
      c.emi_due_day ?? '',
      c.emi_amount ?? '',
      firstEmiCharge,
      '',              // remarks — left blank for manual entry
      fineDue > 0 ? fineDue : '',
      '', '', '', '', '',
    ]));
  }

  return new NextResponse(lines.join('\r\n'), { headers: csvHeaders(filename) });
}
