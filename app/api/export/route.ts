import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import * as XLSX from 'xlsx';

// Column definitions matching existing export format
const CUSTOMER_COLS = [
  'customer_name', 'father_name', 'mobile', 'alternate_number_1', 'alternate_number_2',
  'aadhaar', 'voter_id', 'address', 'landmark', 'model_no', 'imei', 'box_no',
  'purchase_value', 'down_payment', 'disburse_amount', 'purchase_date',
  'emi_due_day', 'emi_amount', 'emi_tenure', 'first_emi_charge_amount',
  'first_emi_charge_paid_at', 'status', 'completion_date', 'completion_remark',
  'retailer_name', 'retailer_mobile',
];

interface CustomerRow {
  id: string;
  customer_name: string;
  father_name?: string;
  mobile: string;
  alternate_number_1?: string;
  alternate_number_2?: string;
  aadhaar?: string;
  voter_id?: string;
  address?: string;
  landmark?: string;
  model_no?: string;
  imei: string;
  box_no?: string;
  purchase_value: number;
  down_payment: number;
  disburse_amount?: number;
  purchase_date: string;
  emi_due_day: number;
  emi_amount: number;
  emi_tenure: number;
  first_emi_charge_amount: number;
  first_emi_charge_paid_at?: string;
  status: string;
  completion_date?: string;
  completion_remark?: string;
  retailer?: { name?: string; mobile?: string } | null;
}

function flattenCustomer(r: CustomerRow) {
  return {
    customer_name: r.customer_name ?? '',
    father_name: r.father_name ?? '',
    mobile: r.mobile ?? '',
    alternate_number_1: r.alternate_number_1 ?? '',
    alternate_number_2: r.alternate_number_2 ?? '',
    aadhaar: r.aadhaar ?? '',
    voter_id: r.voter_id ?? '',
    address: r.address ?? '',
    landmark: r.landmark ?? '',
    model_no: r.model_no ?? '',
    imei: r.imei ?? '',
    box_no: r.box_no ?? '',
    purchase_value: r.purchase_value ?? 0,
    down_payment: r.down_payment ?? 0,
    disburse_amount: r.disburse_amount ?? '',
    purchase_date: r.purchase_date ?? '',
    emi_due_day: r.emi_due_day ?? '',
    emi_amount: r.emi_amount ?? 0,
    emi_tenure: r.emi_tenure ?? '',
    first_emi_charge_amount: r.first_emi_charge_amount ?? 0,
    first_emi_charge_paid_at: r.first_emi_charge_paid_at ?? '',
    status: r.status ?? '',
    completion_date: r.completion_date ?? '',
    completion_remark: r.completion_remark ?? '',
    retailer_name: (r.retailer as { name?: string } | null)?.name ?? '',
    retailer_mobile: (r.retailer as { mobile?: string } | null)?.mobile ?? '',
  };
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

  const serviceClient = createServiceClient();

  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') ?? 'all'; // 'all' | 'running' | 'complete'

  // Build base query — retailer can only see their own customers
  let retailerId: string | null = null;
  if (!isAdmin) {
    const { data: retailer } = await serviceClient
      .from('retailers')
      .select('id')
      .eq('auth_user_id', user.id)
      .single();
    if (!retailer) return NextResponse.json({ error: 'Retailer not found' }, { status: 403 });
    retailerId = retailer.id;
  }

  async function fetchCustomers(status: 'RUNNING' | 'COMPLETE') {
    let q = serviceClient
      .from('customers')
      .select('id,customer_name,father_name,mobile,alternate_number_1,alternate_number_2,aadhaar,voter_id,address,landmark,model_no,imei,box_no,purchase_value,down_payment,disburse_amount,purchase_date,emi_due_day,emi_amount,emi_tenure,first_emi_charge_amount,first_emi_charge_paid_at,status,completion_date,completion_remark,retailer:retailers(name,mobile)')
      .eq('status', status)
      .order('customer_name');
    if (retailerId) q = q.eq('retailer_id', retailerId);
    const { data } = await q;
    return (data ?? []) as CustomerRow[];
  }

  // Build workbook
  const wb = XLSX.utils.book_new();

  if (type === 'running') {
    const rows = await fetchCustomers('RUNNING');
    const ws = XLSX.utils.json_to_sheet(rows.map(flattenCustomer), { header: CUSTOMER_COLS });
    XLSX.utils.book_append_sheet(wb, ws, 'Running');
  } else if (type === 'complete') {
    const rows = await fetchCustomers('COMPLETE');
    const ws = XLSX.utils.json_to_sheet(rows.map(flattenCustomer), { header: CUSTOMER_COLS });
    XLSX.utils.book_append_sheet(wb, ws, 'Complete');
  } else {
    // 'all' — two sheets
    const [runningRows, completeRows] = await Promise.all([
      fetchCustomers('RUNNING'),
      fetchCustomers('COMPLETE'),
    ]);
    const wsRunning = XLSX.utils.json_to_sheet(runningRows.map(flattenCustomer), { header: CUSTOMER_COLS });
    const wsComplete = XLSX.utils.json_to_sheet(completeRows.map(flattenCustomer), { header: CUSTOMER_COLS });
    XLSX.utils.book_append_sheet(wb, wsRunning, 'Running');
    XLSX.utils.book_append_sheet(wb, wsComplete, 'Complete');
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = type === 'all'
    ? 'customers-all.xlsx'
    : type === 'running'
    ? 'customers-running.xlsx'
    : 'customers-complete.xlsx';

  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
