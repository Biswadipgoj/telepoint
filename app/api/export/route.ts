import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { buildCsv, csvHeaders } from '@/lib/csv';
import { buildXlsx, xlsxHeaders, XlsxCell, XlsxSheet } from '@/lib/xlsx';
import { formatShortDateIST } from '@/lib/ist';
import { fetchAllByIds, fetchAllPaged } from '@/lib/dbFetch';

// ── Customer column structure ────────────────────────────────────────────────
// Full customer dump: every field stored on the customer row, plus the EMI 1→12
// loan-history grid. The leading block keeps the familiar layout (IMEI … 1st
// EMI), the EMI grid sits in the middle, and the remaining DB columns follow so
// nothing on the record is left out of the download.
const HEADER = [
  'IMEI NO',
  'SR NO.',
  'CUST NAME',
  'FATHER NAME',
  'AADHAAR',
  'VOTER ID',
  'CUSTOMER NUMBER',
  'ALTARNET NUMBER',
  'ALT NUMBER 2',
  'MODEL',
  'BOX NO',
  'PURCHASE VALUE',
  'DOWN PAYMENT',
  'DISBURSE AMOUNT',
  'EMI AMOUNT',
  'TENURE',
  'EMI DUE DAY',
  '1ST EMI CHARGE',
  '1ST EMI CHARGE PAID',
  'PURCHASE DATE',
  'EMI START DATE',
  '1st EMI',
  'EMI 1', 'EMI 2', 'EMI 3', 'EMI 4', 'EMI 5', 'EMI 6',
  'EMI 7', 'EMI 8', 'EMI 9', 'EMI 10', 'EMI 11', 'EMI 12',
  'RETAILER',
  'STATUS',
  'COMPLETION DATE',
  'COMPLETION REMARK',
  'SETTLEMENT AMOUNT',
  'SETTLEMENT DATE',
  'PHONE LOCKED',
  'ADDRESS',
  'LANDMARK',
  'CUSTOMER PHOTO',
  'AADHAAR FRONT',
  'AADHAAR BACK',
  'BILL PHOTO',
  'EMI CARD PHOTO',
];

interface CustomerRow {
  id: string;
  customer_name: string;
  father_name?: string | null;
  aadhaar?: string | null;
  voter_id?: string | null;
  mobile: string;
  alternate_number_1?: string | null;
  alternate_number_2?: string | null;
  address?: string | null;
  landmark?: string | null;
  imei: string;
  model_no?: string | null;
  box_no?: string | null;
  purchase_value?: number | null;
  down_payment?: number | null;
  disburse_amount?: number | null;
  emi_amount: number;
  emi_tenure: number;
  emi_due_day: number;
  first_emi_charge_amount?: number | null;
  first_emi_charge_paid_at?: string | null;
  emi_start_date?: string | null;
  purchase_date?: string | null;
  status: string;
  completion_date?: string | null;
  completion_remark?: string | null;
  settlement_amount?: number | null;
  settlement_date?: string | null;
  is_locked?: boolean | null;
  customer_photo_url?: string | null;
  aadhaar_front_url?: string | null;
  aadhaar_back_url?: string | null;
  bill_photo_url?: string | null;
  emi_card_photo_url?: string | null;
  retailer?: { name?: string } | null;
}

// Column list pulled from the customers table — every field above maps to a
// real DB column so "all details" really means all details.
const CUSTOMER_COLUMNS =
  'id, customer_name, father_name, aadhaar, voter_id, mobile, alternate_number_1, ' +
  'alternate_number_2, address, landmark, imei, model_no, box_no, purchase_value, ' +
  'down_payment, disburse_amount, emi_amount, emi_tenure, emi_due_day, ' +
  'first_emi_charge_amount, first_emi_charge_paid_at, emi_start_date, purchase_date, ' +
  'status, completion_date, completion_remark, settlement_amount, settlement_date, ' +
  'is_locked, customer_photo_url, aadhaar_front_url, aadhaar_back_url, bill_photo_url, ' +
  'emi_card_photo_url, retailer:retailers(name)';

interface EmiRow {
  customer_id: string;
  emi_no: number;
  due_date: string;
  status: string;
  partial_paid_amount?: number;
  amount: number;
}

function emiCell(emi: EmiRow | undefined): string {
  if (!emi) return '';
  // Show paid amount if approved, partial amount if partial, due date if unpaid.
  if (emi.status === 'APPROVED') return String(Number(emi.amount || 0));
  if (emi.status === 'PARTIALLY_PAID') {
    const paid = Number(emi.partial_paid_amount || 0);
    return paid > 0 ? `PARTIAL ${paid}` : `DUE ${formatShortDateIST(emi.due_date)}`;
  }
  if (emi.status === 'PENDING_APPROVAL') return `PENDING ${Number(emi.amount || 0)}`;
  return `DUE ${formatShortDateIST(emi.due_date)}`;
}

const num = (v: number | null | undefined): string | number =>
  v === null || v === undefined ? '' : Number(v);
const dateCell = (v?: string | null): string => (v ? formatShortDateIST(v) : '');

// Banner row: first two cells empty, retailer name in the 3rd, padded with empty
// cells to span the full header so spreadsheets render it as a section heading.
function bannerRow(retailerName: string): string {
  return `,,"★ ${retailerName.toUpperCase()} ★"` + ','.repeat(HEADER.length - 2);
}

// ── Row generator shared by CSV and XLSX paths ──────────────────────────────
type RowOut = Record<string, unknown> | string;

function buildRowsForStatus(
  customerList: CustomerRow[],
  emiByCustomer: Map<string, EmiRow[]>,
): RowOut[] {
  // Group by retailer name; within each group sort by first EMI date (chronological).
  const byRetailer = new Map<string, CustomerRow[]>();
  for (const c of customerList) {
    const r = c.retailer?.name?.trim() || 'UNASSIGNED';
    const list = byRetailer.get(r) ?? [];
    list.push(c);
    byRetailer.set(r, list);
  }
  for (const [, list] of byRetailer) {
    list.sort((a, b) => {
      const aFirst = (emiByCustomer.get(a.id) ?? []).find(e => e.emi_no === 1)?.due_date ?? '9999-12-31';
      const bFirst = (emiByCustomer.get(b.id) ?? []).find(e => e.emi_no === 1)?.due_date ?? '9999-12-31';
      return aFirst.localeCompare(bFirst);
    });
  }

  const rows: RowOut[] = [];
  let sr = 0;
  const orderedRetailers = Array.from(byRetailer.keys()).sort();
  for (const retailerName of orderedRetailers) {
    const list = byRetailer.get(retailerName)!;
    rows.push(bannerRow(retailerName));
    for (const c of list) {
      sr += 1;
      const emis = (emiByCustomer.get(c.id) ?? []).sort((a, b) => a.emi_no - b.emi_no);
      const firstEmiDate = emis[0]?.due_date;
      const row: Record<string, unknown> = {
        'IMEI NO': "'" + c.imei, // leading apostrophe keeps Excel from treating IMEI as numeric
        'SR NO.': sr,
        'CUST NAME': c.customer_name,
        'FATHER NAME': c.father_name ?? '',
        'AADHAAR': c.aadhaar ? "'" + c.aadhaar : '',
        'VOTER ID': c.voter_id ?? '',
        'CUSTOMER NUMBER': c.mobile,
        'ALTARNET NUMBER': c.alternate_number_1 ?? '',
        'ALT NUMBER 2': c.alternate_number_2 ?? '',
        'MODEL': c.model_no ?? '',
        'BOX NO': c.box_no ?? '',
        'PURCHASE VALUE': num(c.purchase_value),
        'DOWN PAYMENT': num(c.down_payment),
        'DISBURSE AMOUNT': num(c.disburse_amount),
        'EMI AMOUNT': num(c.emi_amount),
        'TENURE': num(c.emi_tenure),
        'EMI DUE DAY': num(c.emi_due_day),
        '1ST EMI CHARGE': num(c.first_emi_charge_amount),
        '1ST EMI CHARGE PAID': c.first_emi_charge_paid_at ? dateCell(c.first_emi_charge_paid_at) : 'NO',
        'PURCHASE DATE': dateCell(c.purchase_date),
        'EMI START DATE': dateCell(c.emi_start_date),
        '1st EMI': firstEmiDate ? formatShortDateIST(firstEmiDate) : '',
        'RETAILER': retailerName,
        'STATUS': c.status,
        'COMPLETION DATE': dateCell(c.completion_date),
        'COMPLETION REMARK': c.completion_remark ?? '',
        'SETTLEMENT AMOUNT': num(c.settlement_amount),
        'SETTLEMENT DATE': dateCell(c.settlement_date),
        'PHONE LOCKED': c.is_locked ? 'YES' : 'NO',
        'ADDRESS': c.address ?? '',
        'LANDMARK': c.landmark ?? '',
        'CUSTOMER PHOTO': c.customer_photo_url ?? '',
        'AADHAAR FRONT': c.aadhaar_front_url ?? '',
        'AADHAAR BACK': c.aadhaar_back_url ?? '',
        'BILL PHOTO': c.bill_photo_url ?? '',
        'EMI CARD PHOTO': c.emi_card_photo_url ?? '',
      };
      for (let i = 1; i <= 12; i += 1) {
        row[`EMI ${i}`] = i > c.emi_tenure ? '—' : emiCell(emis.find(e => e.emi_no === i));
      }
      rows.push(row);
    }
  }
  return rows;
}

async function loadCustomersAndEmis(
  svc: ReturnType<typeof createServiceClient>,
  statuses: string[],
  retailerId: string | null,
): Promise<{ customerList: CustomerRow[]; emiByCustomer: Map<string, EmiRow[]> }> {
  const customerList = await fetchAllPaged<CustomerRow>((from, to) => {
    let q = svc
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .in('status', statuses)
      .order('id')
      .range(from, to);
    if (retailerId) q = q.eq('retailer_id', retailerId);
    return q as unknown as PromiseLike<{ data: CustomerRow[] | null; error: { message: string } | null }>;
  });

  const customerIds = customerList.map(c => c.id);
  const emiByCustomer = new Map<string, EmiRow[]>();
  if (customerIds.length > 0) {
    // Chunk the id-list (URL-length safe) and page each chunk (row-cap safe).
    // Order by the unique (customer_id, emi_no) pair so paging is stable.
    const allEmis = await fetchAllByIds<EmiRow>(customerIds, (chunk, from, to) =>
      svc
        .from('emi_schedule')
        .select('customer_id, emi_no, due_date, status, partial_paid_amount, amount')
        .in('customer_id', chunk)
        .order('customer_id')
        .order('emi_no')
        .range(from, to) as unknown as PromiseLike<{ data: EmiRow[] | null; error: { message: string } | null }>,
    );
    for (const e of allEmis) {
      const list = emiByCustomer.get(e.customer_id) ?? [];
      list.push(e);
      emiByCustomer.set(e.customer_id, list);
    }
  }
  return { customerList, emiByCustomer };
}

// ── XLSX cell projection ────────────────────────────────────────────────────
function rowsToXlsxCells(rows: RowOut[]): XlsxCell[][] {
  const out: XlsxCell[][] = [];
  for (const r of rows) {
    if (typeof r === 'string') {
      // Banner row — first two cells empty, retailer name in the 3rd column.
      const m = r.match(/^,,"(.+?)",/);
      const banner = m ? m[1] : r;
      const cells: XlsxCell[] = ['', '', banner];
      while (cells.length < HEADER.length) cells.push('');
      out.push(cells);
      continue;
    }
    out.push(HEADER.map(h => {
      const v = r[h];
      if (v === undefined || v === null) return '';
      return v as XlsxCell;
    }));
  }
  return out;
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

  const isAdmin = profile?.role === 'super_admin';
  const svc = createServiceClient();

  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') ?? 'running';
  if (type !== 'running' && type !== 'complete' && type !== 'all') {
    return NextResponse.json({ error: 'type must be running, complete, or all' }, { status: 400 });
  }

  let retailerId: string | null = null;
  if (!isAdmin) {
    const { data: retailer } = await svc
      .from('retailers')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();
    if (!retailer) return NextResponse.json({ error: 'Retailer not found' }, { status: 403 });
    retailerId = retailer.id;
  }

  // ── Multi-sheet "All Customers" Excel export ──────────────────────────────
  // One tab per customer status so NO customer the retailer has is ever
  // dropped. Previously only RUNNING + COMPLETE were exported, silently
  // omitting SETTLED and NPA customers even though they exist in the DB.
  if (type === 'all') {
    const STATUS_TABS: { name: string; status: string }[] = [
      { name: 'Running',  status: 'RUNNING'  },
      { name: 'Complete', status: 'COMPLETE' },
      { name: 'Settled',  status: 'SETTLED'  },
      { name: 'NPA',      status: 'NPA'      },
    ];

    const sheets: XlsxSheet[] = [];
    for (const tab of STATUS_TABS) {
      const { customerList, emiByCustomer } = await loadCustomersAndEmis(svc, [tab.status], retailerId);
      const rows = buildRowsForStatus(customerList, emiByCustomer);
      sheets.push({ name: tab.name, header: HEADER, rows: rowsToXlsxCells(rows) });
    }

    const xlsxBuffer = buildXlsx({ sheets });

    // ArrayBuffer slice copy — NextResponse accepts ArrayBuffer as a BodyInit.
    const ab = xlsxBuffer.buffer.slice(
      xlsxBuffer.byteOffset,
      xlsxBuffer.byteOffset + xlsxBuffer.byteLength,
    ) as ArrayBuffer;
    return new NextResponse(ab, {
      headers: xlsxHeaders('all-customers.xlsx'),
    });
  }

  // ── Single-status CSV export (existing behaviour) ─────────────────────────
  const targetStatus = type === 'running' ? 'RUNNING' : 'COMPLETE';
  const { customerList, emiByCustomer } = await loadCustomersAndEmis(svc, [targetStatus], retailerId);
  const rows = buildRowsForStatus(customerList, emiByCustomer);

  const csv = buildCsv({ header: HEADER, rows });
  const filename = type === 'running' ? 'customers-running.csv' : 'customers-complete.csv';
  return new NextResponse(csv, { headers: csvHeaders(filename) });
}
