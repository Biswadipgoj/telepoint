/**
 * TelePoint → GitHub repo backup.
 *
 * Pulls every table from the portal's /api/backup feed and writes it to disk as
 * both JSON and CSV under backups/latest/. A GitHub Actions workflow
 * (.github/workflows/backup.yml) runs this every 12 hours and commits the
 * result, so the repo always holds a complete, recent copy of the database —
 * and git history preserves every previous snapshot for point-in-time recovery.
 *
 * No Google account, no Apps Script, no external quota. The only configuration
 * is two values, read from the environment:
 *
 *   PORTAL_URL    e.g. https://your-portal.vercel.app  (no trailing slash needed)
 *   BACKUP_TOKEN  the same secret set as BACKUP_TOKEN on the server
 *
 * Run locally:  PORTAL_URL=… BACKUP_TOKEN=… node backup/github-backup.mjs
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const PORTAL_URL = (process.env.PORTAL_URL || '').replace(/\/+$/, '');
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || '';

if (!PORTAL_URL || !BACKUP_TOKEN) {
  console.error('Missing PORTAL_URL and/or BACKUP_TOKEN environment variables.');
  process.exit(1);
}

const OUT_DIR = path.join('backups', 'latest');

async function api(query) {
  const url = `${PORTAL_URL}/api/backup${query}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${BACKUP_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${query || '/'} failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** RFC-4180 CSV: quote fields containing quote/comma/newline; double inner quotes. */
function toCsv(columns, rows) {
  const esc = (v) => {
    let s;
    if (v === null || v === undefined) s = '';
    else if (typeof v === 'object') s = JSON.stringify(v); // jsonb / arrays
    else s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(esc).join(',')];
  for (const row of rows) lines.push(columns.map((c) => esc(row[c])).join(','));
  return lines.join('\n') + '\n';
}

async function main() {
  const startedAt = new Date().toISOString();

  // Manifest tells us which tables exist and their expected row counts.
  const manifest = await api('');
  const tableNames = (manifest.tables || []).map((t) => t.table);

  // Start from a clean folder so a removed table can't leave a stale file.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const summary = [];
  for (const name of tableNames) {
    try {
      const payload = await api(`?table=${encodeURIComponent(name)}`);
      const columns = payload.columns || [];
      const rows = payload.rows || [];

      await writeFile(
        path.join(OUT_DIR, `${name}.json`),
        JSON.stringify({ generated_at: payload.generated_at, table: name, count: rows.length, columns, rows }, null, 2),
      );
      await writeFile(path.join(OUT_DIR, `${name}.csv`), toCsv(columns, rows));

      summary.push({ table: name, rows: rows.length });
      console.log(`  ${name}: ${rows.length} rows`);
    } catch (err) {
      summary.push({ table: name, error: err.message });
      console.error(`  ${name}: ERROR ${err.message}`);
    }
  }

  const finishedAt = new Date().toISOString();
  await writeFile(
    path.join('backups', 'backup-manifest.json'),
    JSON.stringify({ started_at: startedAt, finished_at: finishedAt, portal: PORTAL_URL, summary }, null, 2),
  );

  const failures = summary.filter((s) => s.error);
  console.log(`Backup finished: ${summary.length - failures.length}/${summary.length} tables OK at ${finishedAt}`);
  if (failures.length) process.exit(1); // surface partial failures in the Actions log
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
