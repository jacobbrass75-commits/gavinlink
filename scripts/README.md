# Scripts

This directory holds operator-facing entry points. Product logic should live in `src/`; scripts should stay thin and call into the core codebase.

## Layout

- `admin/`: local bootstrap and seed scripts
- `imports/`: data and media ingestion entry points
- `ops/`: recurring maintenance and scoring tasks
- `qa/`: verification sweeps and operational checks

Prefer `npm run ...` when a script is already surfaced there. Add new scripts to the correct bucket instead of dropping them at the root.

Notable import entry points:

- `scripts/imports/import-foreclosure-csv.js`
- `scripts/imports/import-from-realestatetool.js`
- `scripts/imports/transcribe-folder.js`
- `scripts/imports/sync-propertyradar-alerts.js`

Notable admin/setup entry points:

- `scripts/admin/migrate.js`
- `scripts/admin/seed-test-data.js`
- `scripts/admin/auth-gmail-pkce.js`

Notable ops entry points:

- `scripts/ops/run-matching.js`
- `scripts/ops/run-telegram-bot.js`
- `scripts/ops/run-propertyradar-feed.js`
- `scripts/ops/run-wiki-maintenance.js`
- `scripts/ops/publish-obsidian-note.js`
- `scripts/ops/telegram-probe.js`
