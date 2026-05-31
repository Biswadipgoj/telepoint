import { NextRequest, NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Recalculates and persists late fines across the active portfolio by calling
 * the DB-level recalc_all_fines() function.
 *
 * Two ways to invoke:
 *   • Authenticated super_admin (manual "Recalculate fines" trigger).
 *   • External scheduler (Vercel Cron / GitHub Action) presenting the
 *     CRON_SECRET as a Bearer token — for when pg_cron isn't available.
 */
async function run(): Promise<NextResponse> {
  const svc = createServiceClient();
  const { data, error } = await svc.rpc('recalc_all_fines');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, updated: data ?? 0 });
}

function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get('authorization') || '';
  return auth === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (isCronAuthorized(req)) return run();

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single();
  if (profile?.role !== 'super_admin') {
    return NextResponse.json({ error: 'Super Admin only' }, { status: 403 });
  }
  return run();
}

// GET is provided for cron schedulers that only issue GET requests.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return run();
}
