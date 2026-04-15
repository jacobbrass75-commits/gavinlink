# Sullivan Link Brain

Sullivan Link Brain is the backend and broker memory system behind Sullivan Link. It ingests distressed commercial real estate signals, turns them into structured intelligence, and exposes that brain through an API, a CLI, an MCP server, Telegram, webhook-style channels, and recurring workers.

Historical internal names such as `isg-second-brain` still appear in package metadata, container names, and some prompts. The product-level intent in this repo is Sullivan Link Brain.

## Goal

The software is built to help a brokerage team move from raw market signals to actionable outreach:

- import foreclosure and property data
- ingest call notes, voice memos, and documents
- maintain canonical entity, property, buyer, seller, and knowledge records in PostgreSQL
- maintain semantic recall in ChromaDB
- score seller distress and buyer-property fit
- generate a curated narrative layer in `wiki/` without replacing database truth

## Main Surfaces

- API: Express server in `src/api/`, started with `npm start`
- CLI: `brain`, implemented in `src/cli/brain.js`
- MCP server: started with `brain serve`, implemented in `src/mcp/`
- Telegram bot: worker in `src/ops/telegram-bot.js`
- Channel ingress: `/api/channels/{omi,hermes,vermes}`
- Assistant answer surface: `/api/answer`, `brain answer ...`, and MCP `brain_answer`
- Recurring workers: PM2-managed jobs such as the PropertyRadar feed under `src/ops/`
- Ops scripts: grouped under `scripts/admin`, `scripts/imports`, `scripts/ops`, and `scripts/qa`

API, CLI, MCP, Telegram, and the recurring workers all sit on top of the same `src/` codebase and shared `src/app/` orchestration layer. The scripts are support tools for setup, imports, maintenance, and verification.

## Runtime Vs Standalone Tools

The live product runtime is:

- `src/`
- `scripts/` entry points
- `ecosystem.config.cjs`
- PostgreSQL + ChromaDB

The `tools/` directory is different. It contains standalone utilities, bulk exports, and investigative workflows that are useful, but not part of the default PM2/API runtime.

- `tools/broker-email-lookup`: one-off outreach enrichment tooling
- `tools/llc-manager-finder`: standalone LLC manager and contact discovery pipeline
- `tools/realnex-crm`: Python RealNex client and local CRM export workflows

If something in `tools/` becomes product-critical, move the adapter into `src/integrations`, the orchestration into `src/app`, and the entry point into the API/CLI/MCP/ops surfaces.

Generated output from standalone tools is not part of the product runtime.

- progress JSON
- contact dumps
- spreadsheets
- ad hoc export files

Those outputs belong in ignored local `artifacts/` directories or private storage, not in the committed application tree.

## Claude / Assistant Use

Soleil is designed to be used by assistants through the MCP surface, not just by humans reading docs.

- Use `brain_answer` as the default conversational front door.
- Use `brain_lookup` for specific entity or property questions.
- Use `brain_search` for fuzzy recall and broad memory questions.
- Use `brain_match` for buyer-property fit and counterpart discovery.
- Use `brain_daily` for priorities and next actions.
- Use `brain_add` only when the user is explicitly providing information to store.

Do not treat casual chat, corrections, or "don't save that" messages as ingestion. The assistant-facing operating rules live in [CLAUDE_SKILL.md](/Users/yakub/Desktop/sullilink/CLAUDE_SKILL.md), [AGENTS.md](/Users/yakub/Desktop/sullilink/AGENTS.md), and [CLAUDE.md](/Users/yakub/Desktop/sullilink/CLAUDE.md).

## Repo Map

```text
src/
  api/            HTTP routes and request validation
  app/            shared application services and orchestration
  buyers/         Buyer profiles, activity, lender analytics
  cli/            brain CLI entry point
  db/             PostgreSQL connection, schema, migrations
  entities/       Entity extraction, clustering, LLC resolution
  import-export/  File parsing and foreclosure import workflow
  inference/      LLM provider abstraction
  ingestion/      Conversational write path into the brain
  integrations/   External data adapters
  knowledge/      Knowledge entries, embeddings, search, transcription
  matching/       Buyer-seller-property scoring and narratives
  mcp/            MCP tool adapter over Soleil services
  ops/            long-running workers and chat/webhook front doors
  properties/     Property documents and grouping
  sellers/        Seller profiles, distress, motivation, portfolio patterns
  wiki/           Wiki promotion, queueing, linting

scripts/
  admin/          bootstrap and seed scripts
  imports/        foreclosure, external import, transcription entry points
  ops/            matching, seller scoring, wiki maintenance
  qa/             end-to-end sweep and operational verification

tests/
  unit/
  integration/

raw/              immutable source material for the narrative layer
wiki/             curated narrative pages backed by citations
briefs/           module notes, reports, and prompt artifacts
```

## Quick Start

1. Copy `.env.example` to `.env`.
2. Start infrastructure:

```bash
docker compose up -d
```

3. Install dependencies:

```bash
npm install
```

4. Apply migrations:

```bash
npm run migrate
```

5. Seed sample data:

```bash
npm run seed
```

6. Start the API:

```bash
npm start
```

7. Run tests:

```bash
npm test
```

Local-first runtime shortcuts:

```bash
npm run local:up:seed
npm run local:check
npm run local:up:pm2
```

`local:up:seed` brings up Docker services, runs migrations, seeds sample data, and prints a readiness summary. Add `npm run local:up:pm2` if you want it to start the API, Telegram worker, and PropertyRadar feed under PM2 in one step.

## Transport Model

- The app itself serves `/health` and `/api/*`.
- Public deployments may reverse-proxy that app under a prefix such as `/api/brain/*`.
- CLI, MCP, and Telegram default to local shared app calls.
- Set `BRAIN_TRANSPORT=http` only when you explicitly want those surfaces to target a remote HTTP API.
- `/brain/*` is a mixed compatibility layer, not the canonical product API.
- Standalone `tools/*` outputs are not source of truth and should not be treated like live runtime data.

## Runtime Boundary

Canonical runtime:

- `src/api`
- `src/app`
- `src/ops`
- `src/cli`
- `src/mcp`
- `scripts/*` entry points that call the runtime
- `ecosystem.config.cjs`
- PostgreSQL + ChromaDB

Not canonical runtime:

- `tools/*`
- generated files under `tools/*`
- PM2 logs
- deploy finisher logs
- local checkpoint files under `data/*`

## Test Modes

- `npm run test:unit`
  Fast local unit coverage for routing, helpers, assistant behavior, and adapters.
- `npm run test:integration`
  Full integration coverage. This expects local Postgres and Chroma to be available.
- `npm test`
  Runs the whole suite sequentially.

## Common Workflows

Run the core runtime surfaces:

```bash
npm start
brain search "industrial Carson"
brain answer "who is Mike Chen"
brain match "Mike Chen"
brain serve
```

For local development, the CLI, MCP server, and Telegram worker now call the shared app layer directly by default instead of bouncing through HTTP. Set `BRAIN_TRANSPORT=http` only when you explicitly want those surfaces to target a remote API.

Import or enrich data:

```bash
node scripts/imports/import-foreclosure-csv.js /path/to/foreclosures.csv --dry-run
node scripts/imports/import-from-realestatetool.js --region la_county --limit 100
node scripts/imports/transcribe-folder.js /path/to/voice-memos --once
node scripts/imports/sync-propertyradar-alerts.js --dry-run --max-results 10
```

Run operational maintenance:

```bash
npm run match
node scripts/ops/score-sellers.js --report
npm run wiki:maintain
npm run obsidian:publish -- briefs/reports/2026-04-10-soleil-current-state.md sullilink-soleil-current-state-2026-04-10.md
node scripts/qa/run-ioc-sweep.js
```

Gmail / PropertyRadar setup:

```bash
npm run gmail:auth
npm run propertyradar:sync -- --dry-run --max-results 10
npm run propertyradar:feed -- --telegram-summary
npm run propertyradar:feed -- --loop --interval-ms 300000 --telegram-summary
```

Obsidian note publishing:

```bash
npm run obsidian:publish -- ./briefs/reports/2026-04-10-soleil-current-state.md status/soleil-current-state.md
```

Required env vars:

- `OBSIDIAN_API_URL`
- `OBSIDIAN_API_KEY`
- `OBSIDIAN_ALLOW_INSECURE_TLS=true` for the common local self-signed setup

Telegram bootstrap:

```bash
npm run telegram:probe -- --updates
npm run telegram:probe -- --chat-id <chat-id> --message "Soleil is online."
npm run telegram:bot -- --once
npm run telegram:bot
```

Telegram behavior:

- slash commands are supported
- plain text is routed through the shared assistant service first
- use `/add ...` or `save: ...` when you explicitly want note capture
- casual text should not be treated as automatic memory writes anymore

Required env vars:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_DEFAULT_CHAT_ID` for a default destination
- `TELEGRAM_ALLOWED_CHAT_IDS` to restrict who can use the bot
- `TELEGRAM_BOT_OFFSET_FILE` to persist `update_id` state between runs
- `BRAIN_TRANSPORT=http` and `BRAIN_API_URL` only if the bot should talk to a non-local brain API

PropertyRadar feed worker env:

- `PROPERTYRADAR_FEED_INTERVAL_MS=300000`
- `PROPERTYRADAR_FEED_ITERATIONS=` for limited loops during testing

PM2 runtime:

```bash
NODE_ENV=development pm2 start ecosystem.config.cjs
pm2 status
pm2 logs sullilink-api
pm2 logs sullilink-telegram-bot
pm2 logs sullilink-propertyradar-feed
```

Use an internal API base for workers when possible:

- `BRAIN_API_URL=http://127.0.0.1:3100`
- do not point the Telegram bot or feed worker at a public reverse-proxy path unless `/health` and `/api/*` resolve there exactly as they do in the app

Auth defaults:

- Protected write routes fail closed if `ADMIN_API_KEY` is not configured.
- Local development should still set `ADMIN_API_KEY` if you want to exercise the real protected surfaces.
- Channel ingress routes do not use `x-api-key`; they require route-specific secrets:
  `x-omi-secret`, `x-hermes-secret`, and `x-vermes-secret`.
- If you want to mirror production locally, set `ADMIN_API_KEY` and the channel webhook secrets in `.env`.

Runtime adapters:

- RealNex API routes: `/api/realnex/contacts`, `/api/realnex/contacts/:key`, `/api/realnex/companies/:key`, `/api/realnex/properties/:key`, `/api/realnex/disambiguate`, `/api/realnex/sync`
- Channel ingest routes: `/api/channels/omi`, `/api/channels/hermes`, `/api/channels/vermes`
- Telegram bot is a runtime worker, not just a probe script

Additional env vars:

- `REALNEX_API_TOKEN`, `REALNEX_BASE_URL`, `REALNEX_PAGE_SIZE`, `REALNEX_TIMEOUT_MS`
- `OMI_WEBHOOK_SECRET`, `OMI_DEFAULT_SOURCE`
- `HERMES_WEBHOOK_SECRET`, `HERMES_DEFAULT_SOURCE`
- `VERMES_WEBHOOK_SECRET`, `VERMES_DEFAULT_SOURCE`

## Narrative Layer

`raw/` and `wiki/` are part of the product, but they are not the source of truth for structured state.

- PostgreSQL is authoritative for structured records.
- ChromaDB is authoritative for embedding-backed recall.
- `raw/` stores immutable evidence.
- `wiki/` stores curated narrative pages with citations.

Follow the narrative rules in `AGENTS.md`. `CLAUDE.md` is kept as a compatibility mirror for tools that still expect that filename.

## Contributor Notes

- `src/` is the core runtime. Prefer adding product logic there, not into one-off scripts.
- `scripts/` is for operational entry points, not for hiding product features.
- `tools/` is for standalone utilities and historical workflows. Treat it as adjacent to the product, not as the main app.
- `briefs/` is design/history context, not executable truth.
- `ARCHITECTURE.md` explains the current boundaries between core brain domains, workflows, delivery surfaces, and support tooling.
