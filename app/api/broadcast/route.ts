import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
  const isAdmin = profile?.role === 'super_admin';
  const isRetailer = profile?.role === 'retailer';
  if (!isAdmin && !isRetailer) return NextResponse.json({ error: 'Not authorized' }, { status: 403 });

  const body = await req.json();
  const { target_retailer_id, message, expires_at, image_url } = body;
  if (!message?.trim() || !expires_at) return NextResponse.json({ error: 'Message and expiry required' }, { status: 400 });
  if (isAdmin && !target_retailer_id) return NextResponse.json({ error: 'Select a retailer' }, { status: 400 });

  const svc = createServiceClient();
  let retailerId = target_retailer_id, senderName = 'TELEPOINT', senderRole = 'admin';
  if (isRetailer) {
    const { data: r } = await svc.from('retailers').select('id, name').eq('auth_user_id', user.id).single();
    if (!r) return NextResponse.json({ error: 'Retailer not found' }, { status: 404 });
    retailerId = r.id; senderName = r.name; senderRole = 'retailer';
  }

  const { data, error } = await svc.from('broadcast_messages').insert({
    target_retailer_id: retailerId, message: message.trim(), image_url: image_url?.trim() || null,
    expires_at, created_by: user.id, sender_name: senderName, sender_role: senderRole,
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, broadcast: data });
}

export async function DELETE(req: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
  if (profile?.role !== 'super_admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const { error } = await createServiceClient().from('broadcast_messages').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
