# Gemini prompt — generate the TelePoint backup Apps Script

Paste the prompt below into Gemini (e.g. Gemini in Google Sheets / Apps Script,
or gemini.google.com). It will produce a Google Apps Script that turns your
sheet into an automatic, near real-time backup of the TelePoint portal.

After Gemini gives you the code: open your backup Google Sheet → **Extensions →
Apps Script**, paste it in, set the two Script Properties (`PORTAL_URL`,
`BACKUP_TOKEN`), then run `setupTrigger` once. See `README.md` for details.

---

## Prompt to paste into Gemini

> You are writing Google Apps Script (bound to a Google Sheet) that creates an
> automatic backup of a web app's database by polling a REST endpoint.
>
> **The backup endpoint**
>
> - Base URL is stored in a Script Property named `PORTAL_URL`.
> - A bearer token is stored in a Script Property named `BACKUP_TOKEN`.
> - `GET {PORTAL_URL}/api/backup` with header `Authorization: Bearer {BACKUP_TOKEN}`
>   returns JSON: `{ "generated_at": "...", "tables": [ { "table": "customers", "count": 1234 }, ... ] }`.
> - `GET {PORTAL_URL}/api/backup?table={name}` with the same header returns JSON:
>   `{ "generated_at": "...", "table": "customers", "count": 1234, "columns": ["id","customer_name", ...], "rows": [ { "id": "...", "customer_name": "...", ... }, ... ] }`.
> - On error it returns a non-200 status with a JSON `{ "error": "..." }` body.
>
> **The tables to mirror** (each becomes its own sheet/tab with the same name):
> `retailers`, `customers`, `emi_schedule`, `payment_requests`,
> `payment_request_items`, `fine_settings`, `broadcast_messages`, `audit_log`.
>
> **Requirements**
>
> 1. A `backupAll()` function that, for each table: fetches it from the
>    endpoint, finds or creates a tab of that name, clears the tab, and writes
>    a header row from the `columns` array followed by every row in `rows`.
>    Write the whole block in a single `setValues` call for speed. Freeze the
>    header row.
> 2. For each cell value: write empty string for `null`/`undefined`; write
>    `JSON.stringify(value)` for objects/arrays (jsonb columns); otherwise write
>    the value as-is.
> 3. Read `PORTAL_URL` and `BACKUP_TOKEN` from `PropertiesService.getScriptProperties()`.
>    Throw a clear error if either is missing. Strip any trailing slash from
>    `PORTAL_URL`. Use `muteHttpExceptions: true` and throw a descriptive error
>    (including the table name and HTTP status) on non-200 responses, so one bad
>    table doesn't silently corrupt its tab.
> 4. Wrap each table's fetch+write in try/catch so one failure doesn't abort the
>    rest; collect a per-table summary.
> 5. Maintain a `_sync_status` tab that records the last sync time formatted in
>    the `Asia/Kolkata` timezone, plus the per-table row counts / errors.
> 6. A `setupTrigger()` function that deletes any existing time triggers for
>    `backupAll`, then installs a new time-based trigger running `backupAll`
>    every 1 minute, and finally calls `backupAll()` once for an immediate sync.
> 7. A `removeTrigger()` function that deletes the `backupAll` time triggers.
> 8. Plain ES5-style Apps Script (use `var`, function declarations). Add concise
>    comments. Do not hardcode the URL or token — only read them from Script
>    Properties.
>
> Output only the complete `.gs` file content, ready to paste into the Apps
> Script editor.

---

A known-good reference implementation already lives next to this file as
`telepoint-backup.gs` — use it to sanity-check whatever Gemini produces.
