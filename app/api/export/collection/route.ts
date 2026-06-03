import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { csvHeaders, csvCell, csvRow } from '@/lib/csv';
import { calculateTotalFineFromEmis } from '@/lib/fineCalc';
import { EMISchedule } from '@/lib/types';
import { fetchAllByIds, fetchAllPaged } from '@/lib/dbFetch';

const BOM = '﻿';

const MONTHS_UPPER = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Header row repeated for every retailer section (matches sample template + Fine Due column)
const SECTION_HEADER =
  'IMEI NO,SR NO.,CUST NAME,CUSTOMER NUMBER,ALTARNET NUMBER,1st EMI,Date,EMI Amount,1st emi charge,remarks,Fine Due,,,,,';

function formatDMonYY(dateStr: string): string {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length < 3) return '';
  const year2 = parts[0].slice(-2);
  const monthIdx = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  if (monthIdx < 0 || monthIdx > 11) return '';
  return `${day}-${MONTHS_SHORT[monthIdx]}-${year2}`;
}

function monthTitle(month: number, year: number): string {
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
  partial_paid_amount?: number;
}

/**
 * Builds the CSV lines for one retailer's section.
 * First element is always the empty-separator row.
 */
function buildRetailerSection(
  retailerName: string,
  month: number,
  year: number,
  customers: CustomerRow[],
  emisByCustomer: Map<string, EmiRow[]>,
  baseFine: number,
  weeklyIncrement: number,
  startOfMonth: string,
  endOfMonth: string,
): string[] {
  const title = `${retailerName.toUpperCase()} - EMI COLLECTION SHEET FOR THE MONTH OF ${monthTitle(month, year)}`;

  const lines: string[] = [
    ',,,,,,,,,,,,,,,',           // empty separator row
    `${csvCell(title)},,,,,,,,,,,,,,,`, // title row
    SECTION_HEADER,
  ];

  // Every active (RUNNING/NPA) customer belongs on their retailer's collection
  // sheet, so the roster is complete. The old code only kept customers with an
  // EMI due this month OR a prior overdue EMI, which silently dropped active
  // accounts that still owe money in other ways — principal cleared but a fine
  // or 1st-EMI charge outstanding, or a loan whose first EMI lands in a later
  // month. Those customers exist in the DB and show up in search, so they must
  // appear here too. Amount-due / fine-due below naturally read 0 (blank) when
  // nothing is pending this month.
  const included = [...customers];

  if (included.length === 0) return lines; // section header only, no data rows

  // Sort: emi_due_day ASC (nulls last at 99), then first EMI due_date ASC
  included.sort((a, b) => {
    const dayDiff = (a.emi_due_day ?? 99) - (b.emi_due_day ?? 99);
    if (dayDiff !== 0) return dayDiff;
    const aFirst = (emisByCustomer.get(a.id) ?? []).find(e => e.emi_no === 1)?.due_date ?? '9999-99-99';
    const bFirst = (emisByCustomer.get(b.id) ?? []).find(e => e.emi_no === 1)?.due_date ?? '9999-99-99';
    return aFirst.localeCompare(bFirst);
  });

  let sr = 0;
  for (const c of included) {
    sr += 1;
    const emis = emisByCustomer.get(c.id) ?? [];
    const firstEmiDate = formatDMonYY(emis.find(e => e.emi_no === 1)?.due_date ?? '');

    // 1st EMI charge: show amount only if not yet collected (use ?? to preserve ₹0)
    const firstEmiCharge = c.first_emi_charge_paid_at ? '' : (c.first_emi_charge_amount ?? '');

    // Fine Due: total accrued fine on all overdue EMIs as of today
    const fineDue = calculateTotalFineFromEmis(emis as unknown as EMISchedule[], baseFine, weeklyIncrement);

    // EMI amount due: sum remaining balances on all pending EMIs up to end of month.
    // For PARTIALLY_PAID EMIs this shows what still needs to be collected, not the full amount.
    // Blank when nothing is pending — a fully-paid (but still RUNNING) customer
    // owes ₹0 of EMI this month, so we must not fabricate one month's amount.
    const pendingEmis = emis.filter(e =>
      (e.status === 'UNPAID' || e.status === 'PARTIALLY_PAID') && e.due_date <= endOfMonth,
    );
    const emiAmountDisplay = pendingEmis.length > 0
      ? pendingEmis.reduce(
          (sum, e) => sum + Math.max(0, Number(e.amount) - Number(e.partial_paid_amount || 0)),
          0,
        )
      : '';

    lines.push(csvRow([
      c.imei,
      sr,
      c.customer_name,
      c.mobile,
      c.alternate_number_1 ?? '',
      firstEmiDate,
      c.emi_due_day ?? '',
      emiAmountDisplay,
      firstEmiCharge,
      '',                              // remarks — blank for manual entry
      fineDue > 0 ? fineDue : '',
      '', '', '', '', '',
    ]));
  }

  return lines;
}

export async function GET(req: NextRequest) {
  // ── Auth ────────────────────────────────────────────────────────────────
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single();

  if (!profile) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Collection sheet is superadmin-only — retailers cannot download this
  if (profile.role !== 'super_admin') {
    return NextResponse.json({ error: 'Forbidden — superadmin only' }, { status: 403 });
  }

  // ── Params ───────────────────────────────────────────────────────────────
  const svc = createServiceClient();
  const { searchParams } = new URL(req.url);

  const month = parseInt(searchParams.get('month') ?? '', 10);
  const year = parseInt(searchParams.get('year') ?? '', 10);

  if (!month || !year || month < 1 || month > 12 || year < 2020 || year > 2099) {
    return NextResponse.json({ error: 'Valid month (1-12) and year required' }, { status: 400 });
  }

  const paramRetailerId = searchParams.get('retailer_id') ?? null;

  // Month boundaries (YYYY-MM-DD — day-only comparison, no tz needed)
  const startOfMonth = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const endOfMonth = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const monthLabel = `${MONTHS_UPPER[month - 1]}-${String(year).slice(-2)}`;
  const filename = paramRetailerId
    ? `collection-${monthLabel}.csv`
    : `TelePoint-Collection-${monthLabel}.csv`;

  // ── Fine settings ─────────────────────────────────────────────────────────
  const { data: fineSettings } = await svc
    .from('fine_settings')
    .select('default_fine_amount, weekly_fine_increment')
    .eq('id', 1)
    .single();
  const baseFine = Number(fineSettings?.default_fine_amount ?? 450);
  const weeklyIncrement = Number(fineSettings?.weekly_fine_increment ?? 25);

  // ── Retailer list ─────────────────────────────────────────────────────────
  let retailerList: { id: string; name: string }[];
  if (paramRetailerId) {
    const { data: ret } = await svc
      .from('retailers')
      .select('id, name')
      .eq('id', paramRetailerId)
      .single();
    if (!ret) return NextResponse.json({ error: 'Retailer not found' }, { status: 404 });
    retailerList = [ret];
  } else {
    const { data: all } = await svc
      .from('retailers')
      .select('id, name')
      .eq('is_active', true)
      .order('name');
    retailerList = (all ?? []) as { id: string; name: string }[];
  }

  // ── Build CSV ─────────────────────────────────────────────────────────────
  const allLines: string[] = [];
  let isFirstSection = true;

  for (const retailer of retailerList) {
    const customers = await fetchAllPaged<CustomerRow>((from, to) =>
      svc
        .from('customers')
        .select(
          'id, customer_name, mobile, alternate_number_1, imei, emi_amount, emi_due_day, ' +
          'first_emi_charge_amount, first_emi_charge_paid_at',
        )
        .eq('retailer_id', retailer.id)
        // RUNNING + NPA: NPA accounts are defaulted but still owe money, so they
        // belong on a collection sheet. (Previously RUNNING-only, which silently
        // dropped defaulted customers that still show up in search.)
        .in('status', ['RUNNING', 'NPA'])
        .order('id')
        .range(from, to) as unknown as PromiseLike<{ data: CustomerRow[] | null; error: { message: string } | null }>,
    );
    if (customers.length === 0) continue;

    const custIds = customers.map(c => c.id);
    // Order by (customer_id, emi_no) — a unique pair — so pagination never
    // repeats or skips a row across page boundaries.
    const rawEmis = await fetchAllByIds<EmiRow>(custIds, (chunk, from, to) =>
      svc
        .from('emi_schedule')
        .select('customer_id, emi_no, due_date, amount, status, fine_amount, fine_waived, fine_paid_amount, partial_paid_amount')
        .in('customer_id', chunk)
        .order('customer_id')
        .order('emi_no')
        .range(from, to) as unknown as PromiseLike<{ data: EmiRow[] | null; error: { message: string } | null }>,
    );

    const emisByCustomer = new Map<string, EmiRow[]>();
    for (const e of rawEmis) {
      const list = emisByCustomer.get(e.customer_id) ?? [];
      list.push(e);
      emisByCustomer.set(e.customer_id, list);
    }

    const sectionLines = buildRetailerSection(
      retailer.name, month, year,
      customers, emisByCustomer,
      baseFine, weeklyIncrement,
      startOfMonth, endOfMonth,
    );

    if (isFirstSection) {
      // BOM goes only at the very beginning of the file (before the first empty row)
      allLines.push(BOM + sectionLines[0]);
      allLines.push(...sectionLines.slice(1));
      isFirstSection = false;
    } else {
      allLines.push(...sectionLines);
    }
  }

  if (allLines.length === 0) {
    const mt = monthTitle(month, year);
    const empty = [
      BOM + ',,,,,,,,,,,,,,,',
      `${csvCell('EMI COLLECTION SHEET FOR THE MONTH OF ' + mt)},,,,,,,,,,,,,,,`,
      SECTION_HEADER,
    ].join('\r\n');
    return new NextResponse(empty, { headers: csvHeaders(filename) });
  }

  return new NextResponse(allLines.join('\r\n'), { headers: csvHeaders(filename) });
}
