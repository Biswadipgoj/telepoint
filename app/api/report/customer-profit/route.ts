import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const svc = createServiceClient();
  const { data: customers } = await svc.from('customers').select('id, customer_name, imei, mobile, purchase_value, down_payment, disburse_amount, emi_amount, emi_tenure, first_emi_charge_amount, first_emi_charge_paid_at, status, retailer:retailers(name)').order('customer_name');
  const rows: string[][] = [['Retailer','Customer','IMEI','Mobile','Purchase Value','Down Payment','Disburse','EMI Amount','Tenure','Total EMI Value','1st Charge','Total Paid EMI','Total Paid Fine','Total Paid Charge','Total Collected','Profit (Collected - Disburse)','Status']];
  for (const c of customers || []) {
    const { data: emis } = await svc.from('emi_schedule').select('status, amount, fine_amount, fine_paid_amount').eq('customer_id', c.id);
    const paidEmis = (emis || []).filter(e => e.status === 'APPROVED');
    const totalEmiPaid = paidEmis.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const totalFinePaid = (emis || []).reduce((s, e) => s + (Number(e.fine_paid_amount) || 0), 0);
    const chargePaid = c.first_emi_charge_paid_at ? (c.first_emi_charge_amount || 0) : 0;
    const totalCollected = totalEmiPaid + totalFinePaid + chargePaid;
    const disburse = Number(c.disburse_amount) || (c.purchase_value - c.down_payment);
    const profit = totalCollected - disburse;
    const rn = (c.retailer as {name?:string})?.name || '';
    rows.push([rn, c.customer_name, "'" + c.imei, c.mobile, String(c.purchase_value), String(c.down_payment), String(disburse), String(c.emi_amount), String(c.emi_tenure), String(c.emi_amount * c.emi_tenure), String(c.first_emi_charge_amount || 0), String(totalEmiPaid), String(totalFinePaid), String(chargePaid), String(totalCollected), String(profit), c.status]);
  }
  const csv = rows.map(r => r.join(',')).join('\r\n');
  return new NextResponse(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="Customer_Wise_Profit.csv"' } });
}
