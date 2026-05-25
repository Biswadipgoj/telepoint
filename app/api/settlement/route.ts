import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
  if (profile?.role !== 'super_admin') {
    return NextResponse.json({ error: 'Only Super Admin can settle accounts' }, { status: 403 });
  }

  const body = await req.json();
  const { customer_id, settlement_amount } = body;
  if (!customer_id || !settlement_amount || Number(settlement_amount) <= 0) {
    return NextResponse.json({ error: 'customer_id and settlement_amount are required' }, { status: 400 });
  }

  const svc = createServiceClient();
  const now = new Date().toISOString();

  // Verify customer exists and is RUNNING
  const { data: customer } = await svc.from('customers').select('id, status, customer_name').eq('id', customer_id).single();
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  if (customer.status !== 'RUNNING') {
    return NextResponse.json({ error: 'Only RUNNING customers can be settled' }, { status: 400 });
  }

  // Mark all remaining UNPAID EMIs as APPROVED with settlement note
  await svc.from('emi_schedule').update({
    status: 'APPROVED',
    paid_at: now,
    mode: 'CASH',
    approved_by: user.id,
    collected_by_role: 'admin',
    collected_by_user_id: user.id,
  }).eq('customer_id', customer_id).eq('status', 'UNPAID');

  // Also approve any PENDING_APPROVAL
  await svc.from('emi_schedule').update({
    status: 'APPROVED',
    paid_at: now,
    approved_by: user.id,
  }).eq('customer_id', customer_id).eq('status', 'PENDING_APPROVAL');

  // Update customer to SETTLED
  const { error: updateErr } = await svc.from('customers').update({
    status: 'SETTLED',
    settlement_amount: Number(settlement_amount),
    settlement_date: now.split('T')[0],
    settled_by: user.id,
    completion_date: now.split('T')[0],
    completion_remark: `Settled for ${settlement_amount}`,
  }).eq('id', customer_id);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Audit log
  await svc.from('audit_log').insert({
    actor_user_id: user.id,
    actor_role: 'super_admin',
    action: 'SETTLEMENT',
    table_name: 'customers',
    record_id: customer_id,
    after_data: { settlement_amount, status: 'SETTLED' },
    remark: `Account settled for Rs ${settlement_amount}`,
  });

  return NextResponse.json({ success: true, customer_id });
}
