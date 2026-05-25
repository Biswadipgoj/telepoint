import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
  const isAdmin = profile?.role === 'super_admin';
  const isRetailer = profile?.role === 'retailer';
  if (!isAdmin && !isRetailer) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const svc = createServiceClient();
  const m = parseInt(req.nextUrl.searchParams.get('month') || String(new Date().getMonth() + 1));
  const y = parseInt(req.nextUrl.searchParams.get('year') || String(new Date().getFullYear()));

  // IST-aware month boundaries (UTC+5:30)
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const monthStartUTC = new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS);
  const monthEndUTC   = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999) - IST_OFFSET_MS);

  // Scope: admin sees all retailers; retailer sees only self
  let retailerScope: { id: string; name: string }[] = [];
  if (isAdmin) {
    const { data: retailers } = await svc.from('retailers').select('id, name').eq('is_active', true).order('name');
    retailerScope = retailers || [];
  } else {
    const { data: retailer } = await svc.from('retailers').select('id, name').eq('auth_user_id', user.id).single();
    if (!retailer) return NextResponse.json({ error: 'Retailer not found' }, { status: 403 });
    retailerScope = [retailer];
  }

  const rows: string[][] = [['Retailer', 'Total EMI', 'Total Fine', 'Total 1st Charge', 'Total Collection', 'Customers']];
  for (const r of retailerScope) {
    const { data: payments } = await svc
      .from('payment_requests')
      .select('total_emi_amount, fine_amount, first_emi_charge_amount, total_amount, customer_id')
      .eq('retailer_id', r.id)
      .eq('status', 'APPROVED')
      .gte('approved_at', monthStartUTC.toISOString())
      .lte('approved_at', monthEndUTC.toISOString());

    const p = payments || [];
    const emi    = p.reduce((s, x) => s + (Number(x.total_emi_amount) || 0), 0);
    const fine   = p.reduce((s, x) => s + (Number(x.fine_amount) || 0), 0);
    const charge = p.reduce((s, x) => s + (Number(x.first_emi_charge_amount) || 0), 0);
    const tot    = p.reduce((s, x) => s + (Number(x.total_amount) || 0), 0);
    const custs  = new Set(p.map(x => x.customer_id)).size;
    if (tot > 0) rows.push([r.name, String(emi), String(fine), String(charge), String(tot), String(custs)]);
  }

  const csv = rows.map(r => r.join(',')).join('\r\n');
  const mn  = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][m - 1];
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="Retailer_Collection_${mn}_${y}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
