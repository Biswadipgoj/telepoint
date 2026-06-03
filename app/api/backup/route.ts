import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { fetchAllPaged } from '@/lib/dbFetch';

// ─────────────────────────────────────────────────────────────────────────────
// Backup feed for the Google Sheets mirror.
//
// A Google Apps Script (see /backup) polls this endpoint on a short timer and
// overwrites one tab per table, so the spreadsheet is a near-live mirror of the
// portal database — including all historical rows.
//
//   GET /api/backup                          → manifest: table names + row counts
//   GET /api/backup?table=customers          → every row of that table (JSON)
//
// Auth: send the shared secret as `Authorization: Bearer <BACKUP_TOKEN>` or
// `?token=<BACKUP_TOKEN>`. Set BACKUP_TOKEN in the server environment. Without
// it configured the endpoint refuses to serve (fail-closed).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';

// Whitelist of exportable tables → the column used for stable ordering. Only
// these tables are ever readable through this endpoint.
const TABLES: Record<string, string> = {
  retailers:             'id',
  customers:             'id',
  emi_schedule:          'id',
  payment_requests:      'id',
  payment_request_items: 'id',
  fine_settings:         'id',
  broadcast_messages:    'id',
  audit_log:             'id',
};

function authorize(req: NextRequest): boolean {
  const expected = process.env.BACKUP_TOKEN;
  if (!expected) return false; // fail-closed when unconfigured
  const header = req.headers.get('authorization') || '';
  const bearer = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : '';
  const queryToken = req.nextUrl.searchParams.get('token') || '';
  const provided = bearer || queryToken;
  // Constant-ish comparison (length check first); tokens are high-entropy.
  return provided.length > 0 && provided === expected;
}

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const svc = createServiceClient();
  const table = req.nextUrl.searchParams.get('table');
  const generated_at = new Date().toISOString();

  // ── Manifest: list tables + current row counts ────────────────────────────
  if (!table) {
    const tables: { table: string; count: number }[] = [];
    for (const name of Object.keys(TABLES)) {
      const { count } = await svc.from(name).select('*', { count: 'exact', head: true });
      tables.push({ table: name, count: count ?? 0 });
    }
    return NextResponse.json(
      { generated_at, tables },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ── Single-table dump (all rows, stably ordered, fully paginated) ─────────
  const orderBy = TABLES[table];
  if (!orderBy) {
    return NextResponse.json({ error: `Unknown or non-exportable table: ${table}` }, { status: 400 });
  }

  const rows = await fetchAllPaged<Record<string, unknown>>((from, to) =>
    svc.from(table).select('*').order(orderBy, { ascending: true }).range(from, to),
  );

  // Column order from the first row's keys, so the sheet has stable columns.
  const columns = rows.length ? Object.keys(rows[0]) : [];

  return NextResponse.json(
    { generated_at, table, count: rows.length, columns, rows },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
