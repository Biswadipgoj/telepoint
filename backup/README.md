# TelePoint → Google Sheets automatic backup

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

## What's here

| File | Purpose |
|------|---------|
| `telepoint-backup.gs` | The Apps Script that pulls data and writes the tabs. |
| `GEMINI_PROMPT.md` | A prompt to give Gemini so it generates the script for you. |
| `README.md` | This guide. |

The server side is the endpoint `GET /api/backup` (code in
`app/api/backup/route.ts`).

## One-time server setup

1. Generate a long random secret (this is your `BACKUP_TOKEN`):
   ```bash
   openssl rand -hex 32
   ```
2. Add it to the portal's environment variables (e.g. Vercel → Project →
   Settings → Environment Variables):
   ```
   BACKUP_TOKEN = <the value from step 1>
   ```
   Redeploy so the variable takes effect. Until this is set the endpoint
   returns `401` for everyone (fail-closed).
3. Verify (replace host + token):
   ```bash
   curl -H "Authorization: Bearer <BACKUP_TOKEN>" https://your-portal/api/backup
   # → {"generated_at":"…","tables":[{"table":"customers","count":1234}, …]}
   ```

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

## Security notes

- The endpoint is **fail-closed**: no `BACKUP_TOKEN` configured → `401`.
- Treat `BACKUP_TOKEN` like a password. It grants read access to all backed-up
  tables. Rotate it by changing the value on both the server and the Script
  properties.
- Prefer the `Authorization: Bearer` header (used by the script) over the
  `?token=` query form, which can leak into logs.
