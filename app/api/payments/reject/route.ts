import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { reverseApprovedRequestEffects, recomputeCustomerCompletion } from '@/lib/paymentReconcile';

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
    if (profile?.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { request_id, reason } = body;
    if (!request_id || !reason) return NextResponse.json({ error: 'request_id and reason are required' }, { status: 400 });

    const svc = createServiceClient();
    const { data: request, error } = await svc.from('payment_requests').select('*').eq('id', request_id).single();
    if (error || !request) return NextResponse.json({ error: 'Request not found' }, { status: 404 });

    if (request.status === 'APPROVED') {
      await reverseApprovedRequestEffects(svc, request);
      await recomputeCustomerCompletion(svc, request.customer_id);
    }


    const { data: items } = await svc.from('payment_request_items').select('emi_schedule_id').eq('payment_request_id', request_id);
    const emiIds = (items || []).map((item: { emi_schedule_id: string }) => item.emi_schedule_id).filter(Boolean);
    if (emiIds.length) {
      const { data: emiRows } = await svc.from('emi_schedule').select('id, amount, partial_paid_amount').in('id', emiIds);
      for (const emi of emiRows || []) {
        const partialPaid = Number((emi as { partial_paid_amount?: number }).partial_paid_amount || 0);
        await svc.from('emi_schedule').update({ status: partialPaid > 0 ? 'PARTIALLY_PAID' : 'UNPAID' }).eq('id', (emi as { id: string }).id);
      }
    }

    const { error: reqErr } = await svc.from('payment_requests').update({
      status: 'REJECTED',
      rejected_by: user.id,
      rejected_at: new Date().toISOString(),
      rejection_reason: reason,
      approved_by: null,
      approved_at: null,
    }).eq('id', request_id);
    if (reqErr) return NextResponse.json({ error: reqErr.message }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('payments/reject failed', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unexpected server error' }, { status: 500 });
  }
}
