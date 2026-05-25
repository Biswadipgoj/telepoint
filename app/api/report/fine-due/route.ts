import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const svc = createServiceClient();
  const { data: emis } = await svc.from('emi_schedule').select('emi_no, due_date, amount, fine_amount, fine_paid_amount, fine_waived, customer:customers(customer_name, imei, mobile, retailer:retailers(name))').gt('fine_amount', 0).eq('fine_waived', false).order('due_date');
  const rows: string[][] = [['Retailer','Customer','IMEI','Mobile','EMI #','Due Date','EMI Amount','Fine Amount','Fine Paid','Fine Remaining','Days Overdue']];
  for (const e of emis || []) {
    const c = e.customer as unknown as Record<string, unknown> | null;
    const remaining = (Number(e.fine_amount)||0) - (Number(e.fine_paid_amount)||0);
    if (remaining <= 0) continue;
    const days = Math.max(0, Math.floor((Date.now() - new Date(e.due_date).getTime()) / 86400000));
    rows.push([
      ((c?.retailer as {name?:string})?.name) || '',
      (c?.customer_name as string) || '', "'" + ((c?.imei as string) || ''),
      (c?.mobile as string) || '', String(e.emi_no), e.due_date,
      String(e.amount), String(e.fine_amount), String(e.fine_paid_amount || 0),
      String(remaining), String(days)
    ]);
  }
  const csv = rows.map(r => r.join(',')).join('\r\n');
  return new NextResponse(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="Fine_Due_Report.csv"' } });
}
