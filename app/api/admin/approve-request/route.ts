import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
    if (profile?.role !== 'super_admin') return NextResponse.json({ error: 'Forbidden — admins only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const { request_id, remark } = body as { request_id?: string; remark?: string };
    if (!request_id) return NextResponse.json({ error: 'request_id is required' }, { status: 400 });

    const svc = createServiceClient();

    // Use atomic DB function — single transaction, idempotent
    const { data: result, error: rpcErr } = await svc.rpc('approve_payment_request', {
      p_request_id: request_id,
      p_admin_id:   user.id,
      p_remark:     remark ?? null,
    });

    if (rpcErr) {
      console.error('approve_payment_request RPC error:', rpcErr);
      return NextResponse.json({ error: rpcErr.message }, { status: 500 });
    }

    const res = result as { success?: boolean; error?: string; already_approved?: boolean; approved_at?: string };
    if (!res?.success) return NextResponse.json({ error: res?.error || 'Approval failed' }, { status: 400 });

    return NextResponse.json({ success: true, request_id, approved_at: res.approved_at, already_approved: res.already_approved ?? false });
  } catch (err) {
    console.error('approve-request failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Unexpected error' }, { status: 500 });
  }
}
