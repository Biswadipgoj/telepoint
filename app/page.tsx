export const dynamic = 'force-dynamic';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export default async function RootPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();

  if (profile?.role === 'super_admin') redirect('/admin');
  if (profile?.role === 'retailer') redirect('/retailer');

  redirect('/login');
}
