import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
    if (profile?.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { request_id, remark } = body;
    if (!request_id) return NextResponse.json({ error: 'request_id required' }, { status: 400 });

    const svc = createServiceClient();
    const { data: result, error: rpcErr } = await svc.rpc('approve_payment_request', {
      p_request_id: request_id,
      p_admin_id:   user.id,
      p_remark:     remark ?? null,
    });

    if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 });

    const res = result as { success?: boolean; error?: string; approved_at?: string };
    if (!res?.success) return NextResponse.json({ error: res?.error || 'Failed' }, { status: 400 });

    return NextResponse.json({ success: true, request_id, approved_at: res.approved_at });
  } catch (err) {
    console.error('payments/approve failed', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unexpected error' }, { status: 500 });
  }
}
