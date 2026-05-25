import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

// POST: Generate persistent token for customer app auto-login
export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
  if (profile?.role !== 'super_admin' && profile?.role !== 'retailer')
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  const { customer_id } = await req.json();
  if (!customer_id) return NextResponse.json({ error: 'customer_id required' }, { status: 400 });

  const svc = createServiceClient();
  const { data: customer } = await svc.from('customers').select('id, customer_name, mobile').eq('id', customer_id).single();
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  // Generate unique token
  const token = crypto.randomUUID().replace(/-/g, '') + Date.now().toString(36);

  // Upsert — one active token per customer
  const { data: existing } = await svc.from('customer_app_tokens').select('id').eq('customer_id', customer_id).maybeSingle();
  if (existing) {
    await svc.from('customer_app_tokens').update({ token, updated_at: new Date().toISOString() }).eq('customer_id', customer_id);
  } else {
    await svc.from('customer_app_tokens').insert({ customer_id, token, created_by: user.id });
  }

  return NextResponse.json({ token, customer_name: customer.customer_name, mobile: customer.mobile });
}

// GET: Validate token and return full customer data (auto-login)
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });

  const svc = createServiceClient();
  const { data: tokenRow } = await svc.from('customer_app_tokens')
    .select('customer_id, is_active').eq('token', token).maybeSingle();

  if (!tokenRow || !tokenRow.is_active)
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });

  // Track access
  await svc.from('customer_app_tokens').update({
    last_accessed_at: new Date().toISOString(),
  }).eq('token', token);

  // Load full customer data
  const { data: customer } = await svc.from('customers').select(`
    id, retailer_id, customer_name, father_name, aadhaar, mobile,
    alternate_number_1, alternate_number_2,
    model_no, imei, purchase_value, down_payment, disburse_amount,
    purchase_date, emi_due_day, emi_amount, emi_tenure,
    first_emi_charge_amount, first_emi_charge_paid_at,
    customer_photo_url, status, is_locked, lock_provider,
    retailer:retailers(name, mobile)
  `).eq('id', tokenRow.customer_id).single();

  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });

  const { data: emis } = await svc.from('emi_schedule')
    .select('id, emi_no, due_date, amount, status, paid_at, mode, partial_paid_amount, partial_paid_at, fine_amount, fine_waived, fine_paid_amount, fine_paid_at')
    .eq('customer_id', customer.id).order('emi_no');

  let breakdown = null;
  try {
    const { data: bd } = await svc.rpc('get_due_breakdown', { p_customer_id: customer.id });
    breakdown = bd;
  } catch { breakdown = null; }

  const { data: broadcasts } = await svc.from('broadcast_messages')
    .select('id, message, image_url, expires_at, sender_name, sender_role')
    .eq('target_retailer_id', customer.retailer_id)
    .gte('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  return NextResponse.json({
    customer, emis: emis || [], breakdown: breakdown || null, broadcasts: broadcasts || [],
  });
}
