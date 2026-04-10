# Scripts

This directory holds operator-facing entry points. Product logic should live in `src/`; scripts should stay thin and call into the core codebase.

## Layout

- `admin/`: local bootstrap and seed scripts
- `imports/`: data and media ingestion entry points
- `ops/`: recurring maintenance and scoring tasks
- `qa/`: verification sweeps and operational checks

Prefer `npm run ...` when a script is already surfaced there. Add new scripts to the correct bucket instead of dropping them at the root.
