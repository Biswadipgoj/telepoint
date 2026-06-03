import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { buildCsv, csvHeaders } from '@/lib/csv';
import { buildXlsx, xlsxHeaders, XlsxCell, XlsxSheet } from '@/lib/xlsx';
import { formatShortDateIST } from '@/lib/ist';

// ── Customer column structure ────────────────────────────────────────────────
// The "12-month trailing column structure" spec: starts at IMEI NO and ends
// at ADDRESS, with EMI 1 → EMI 12 columns covering the loan history.
const HEADER = [
  'IMEI NO',
  'SR NO.',
  'CUST NAME',
  'CUSTOMER NUMBER',
  'ALTARNET NUMBER',
  'MODEL',
  '1st EMI',
  'EMI 1', 'EMI 2', 'EMI 3', 'EMI 4', 'EMI 5', 'EMI 6',
  'EMI 7', 'EMI 8', 'EMI 9', 'EMI 10', 'EMI 11', 'EMI 12',
  'RETAILER',
  'STATUS',
  'ADDRESS',
];

interface CustomerRow {
  id: string;
  customer_name: string;
  mobile: string;
  alternate_number_1?: string;
  alternate_number_2?: string;
  address?: string;
  imei: string;
  model_no?: string;
  emi_amount: number;
  emi_tenure: number;
  emi_due_day: number;
  first_emi_charge_amount: number;
  first_emi_charge_paid_at?: string;
  emi_start_date?: string;
  purchase_date?: string;
  status: string;
  retailer?: { name?: string } | null;
}

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
    // Retailer banner — single populated cell so spreadsheets render it as a heading.
    rows.push(`,,"★ ${retailerName.toUpperCase()} ★",,,,,,,,,,,,,,,,,,,`);
    for (const c of list) {
      sr += 1;
      const emis = (emiByCustomer.get(c.id) ?? []).sort((a, b) => a.emi_no - b.emi_no);
      const firstEmiDate = emis[0]?.due_date;
      const row: Record<string, unknown> = {
        'IMEI NO': "'" + c.imei, // leading apostrophe keeps Excel from treating IMEI as numeric
        'SR NO.': sr,
        'CUST NAME': c.customer_name,
        'CUSTOMER NUMBER': c.mobile,
        'ALTARNET NUMBER': c.alternate_number_1 ?? '',
        'MODEL': c.model_no ?? '',
        '1st EMI': firstEmiDate ? formatShortDateIST(firstEmiDate) : '',
        'RETAILER': retailerName,
        'STATUS': c.status,
        'ADDRESS': c.address ?? '',
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
  let q = svc
    .from('customers')
    .select(
      'id, customer_name, mobile, alternate_number_1, alternate_number_2, address, imei, model_no, ' +
      'emi_amount, emi_tenure, emi_due_day, first_emi_charge_amount, first_emi_charge_paid_at, ' +
      'emi_start_date, purchase_date, status, retailer:retailers(name)',
    )
    .in('status', statuses)
    .order('customer_name');
  if (retailerId) q = q.eq('retailer_id', retailerId);

  const { data: customers } = await q;
  const customerList = (customers as unknown as CustomerRow[] | null) ?? [];

  const customerIds = customerList.map(c => c.id);
  const emiByCustomer = new Map<string, EmiRow[]>();
  if (customerIds.length > 0) {
    const { data: allEmis } = await svc
      .from('emi_schedule')
      .select('customer_id, emi_no, due_date, status, partial_paid_amount, amount')
      .in('customer_id', customerIds);
    for (const e of (allEmis as EmiRow[] | null) ?? []) {
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
      const m = r.match(/^,,"(.+)",/);
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
