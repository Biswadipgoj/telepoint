# TelePoint database backup

There are two ways to mirror the portal database for safekeeping. **The
GitHub Actions method below is the recommended, working default** — it has no
Google account, no Apps Script, and no daily quota to hit. The older Google
Sheets method is kept further down as an optional alternative.

Both read from the same secured endpoint, `GET /api/backup` (code in
`app/api/backup/route.ts`).

---

# Method 1 (recommended): GitHub Actions → repo

A scheduled GitHub Action runs **every 12 hours**, pulls every table from
`/api/backup`, and commits the data as JSON + CSV into `backups/latest/`. The
repo always holds a complete recent copy, and git history preserves every
previous snapshot for point-in-time recovery.

```
Portal DB  ──/api/backup──▶  GitHub Action (12-hour cron)  ──▶  backups/latest/*.json + *.csv (committed)
```

## Files

| File | Purpose |
|------|---------|
| `.github/workflows/backup.yml` | The scheduled workflow (runs every 12 h). |
| `backup/github-backup.mjs` | Node script that pulls the tables and writes the files. |
| `backups/latest/` | The most recent snapshot (one JSON + one CSV per table). |
| `backups/backup-manifest.json` | Last run time + per-table row counts. |

## Setup (one time)

1. **Server token** — generate a long random secret and set it on the portal:
   ```bash
   openssl rand -hex 32
   ```
   Add it as an environment variable `BACKUP_TOKEN` (e.g. Vercel → Project →
   Settings → Environment Variables) and redeploy. Until it's set the endpoint
   returns `401` for everyone (fail-closed).
2. **Repo secrets** — in GitHub: **Settings → Secrets and variables → Actions
   → New repository secret**, add two:
   | Secret | Value |
   |--------|-------|
   | `PORTAL_URL` | `https://your-portal.vercel.app` (no trailing slash needed) |
   | `BACKUP_TOKEN` | the same secret you set on the server |
3. That's it. The workflow runs automatically every 12 hours. To run it now,
   go to the **Actions** tab → **Database backup** → **Run workflow**.

## How it behaves

- **Frequency:** every 12 hours (`cron: '0 */12 * * *'`), plus on-demand from
  the Actions tab. To change it, edit the `cron` line in the workflow.
- **Full refresh:** each run rewrites `backups/latest/` from the current DB, so
  there are never stale leftovers. A commit is only made when something changed.
- **History:** every changed snapshot is its own commit, so you can recover any
  past state from git (`git show <commit>:backups/latest/customers.csv`).
- **All details:** every column of every whitelisted table is written. `jsonb`
  / array columns are stored as JSON text in the CSV and as real JSON in `.json`.
- **Tables mirrored:** `retailers`, `customers`, `emi_schedule`,
  `payment_requests`, `payment_request_items`, `fine_settings`,
  `broadcast_messages`, `audit_log`. To add/remove tables, edit the whitelist
  in `app/api/backup/route.ts` — the script picks up the manifest automatically.

## Verify

```bash
curl -H "Authorization: Bearer <BACKUP_TOKEN>" https://your-portal/api/backup
# → {"generated_at":"…","tables":[{"table":"customers","count":1234}, …]}
```

## Security notes

- The endpoint is **fail-closed**: no `BACKUP_TOKEN` configured → `401`.
- Treat `BACKUP_TOKEN` like a password — it grants read access to all
  backed-up tables. Rotate it by changing the value on both the server and the
  GitHub repo secret.
- Prefer the `Authorization: Bearer` header (used by the script) over the
  `?token=` query form, which can leak into logs.

---

# Method 2 (optional): Google Sheets mirror

This folder sets up an **automatic mirror** of the portal database into a
Google Sheet. A Google Apps Script polls a secured backup endpoint on the
portal and refreshes one tab per table **every 12 hours**, including all
historical rows. If anything ever happens to the database, the sheet is a
complete, recent copy.

```
Portal DB  ──/api/backup──▶  Apps Script (12-hour timer)  ──▶  Google Sheet (1 tab/table)
```

> **Why 12 hours and not every minute?** The original setup ran every minute.
> At that rate the script makes ~11,500 `UrlFetchApp` calls a day, which blows
> past Google's daily quota — after which every call fails and the sheet
> **silently stops updating** (the "backup not working" symptom). Running twice
> a day (16 calls/day) stays well within quota and is plenty for a safety
> backup. If you previously installed the 1-minute version, just re-run
> `setupTrigger` once — it removes the old trigger and installs the new one.

Files: `telepoint-backup.gs` (the Apps Script) and `GEMINI_PROMPT.md` (a prompt
that regenerates it). This method needs the same server `BACKUP_TOKEN` from
Method 1 — set that first if you haven't.

## One-time Google Sheet setup

1. Create a new Google Sheet (this becomes the backup workbook).
2. **Extensions → Apps Script**. Delete the placeholder `Code.gs` content and
   paste in `telepoint-backup.gs` (or let Gemini generate it — see
   `GEMINI_PROMPT.md`).
3. **Project Settings (gear icon) → Script properties → Add script property**,
   add two:
   | Property | Value |
   |----------|-------|
   | `PORTAL_URL` | `https://your-portal.vercel.app` (no trailing slash needed) |
   | `BACKUP_TOKEN` | the same secret you set on the server |
4. Back in the editor, select the function **`setupTrigger`** and click **Run**.
   Approve the authorization prompt the first time. This:
   - installs a time trigger that runs `backupAll` **every 12 hours**, and
   - performs an immediate first full sync.
5. Open the sheet — you'll see one tab per table plus a `_sync_status` tab
   showing the last sync time and per-table row counts.

## How it behaves

- **Frequency:** every 12 hours (twice a day). This keeps the sheet within
  Google's UrlFetchApp quota so it never silently stops updating, while still
  being a fresh safety copy. Apps Script's `everyHours()` accepts
  `1, 2, 4, 6, 8, 12` — 12 is the longest single-trigger interval.
- **No overlapping runs:** `backupAll` takes a script lock, so a manual run
  and a scheduled run can never collide and corrupt a tab mid-write.
- **Full refresh:** every run clears each tab and rewrites it from the current
  DB, so previously-collected rows and any edits/corrections are always
  reflected — no stale leftovers.
- **All details:** every column of every whitelisted table is written. `jsonb`
  / array columns are stored as JSON text.
- **Tables mirrored:** `retailers`, `customers`, `emi_schedule`,
  `payment_requests`, `payment_request_items`, `fine_settings`,
  `broadcast_messages`, `audit_log`. To add/remove tables, edit the `TABLES`
  array in the script **and** the whitelist in `app/api/backup/route.ts`.

## Stop / change syncing

- Run **`removeTrigger`** in the Apps Script editor to stop automatic syncing.
- Run **`backupAll`** any time for a manual on-demand sync.
- To change the cadence, edit `everyHours(12)` in `setupTrigger` (Apps Script
  supports `everyHours(1|2|4|6|8|12)`, or `everyMinutes(1|5|10|15|30)` for more
  frequent — but watch the daily quota note above).

## Want more frequent / instant updates instead?

Every 12 hours is the reliable, quota-safe default for a safety backup. If you
later need *instant* updates on every write, the alternative is to push from the
server to the Google Sheets API using a service account on each create/approve.
That's more moving parts (a Google Cloud service account + the Sheets API
client) and is documented as a follow-up — ask and it can be added.

The same security notes from Method 1 apply: the endpoint is fail-closed, the
`BACKUP_TOKEN` is a password (here it lives in the Sheet's Script properties),
and the `Authorization: Bearer` header is preferred over `?token=`.
