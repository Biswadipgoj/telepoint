# Database backups

This folder is filled automatically by the **Database backup** GitHub Action
(`.github/workflows/backup.yml`), which runs every 12 hours.

- `latest/<table>.json` — every row of each table as JSON (full, exact copy).
- `latest/<table>.csv` — the same data as CSV, openable in Excel / Google Sheets.
- `backup-manifest.json` — when the last backup ran and per-table row counts.

`latest/` always holds the most recent snapshot. To recover an **older** copy,
use git history (e.g. `git log -- backups/latest/customers.csv`, then
`git show <commit>:backups/latest/customers.csv`).

See `../backup/README.md` for setup and how it works.
