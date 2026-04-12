# Sullivan Link Brain Architecture

## Purpose

Sullivan Link Brain is a local-first commercial real estate intelligence backend. Its job is to turn distressed-property signals and broker knowledge into a usable operating system for sourcing, qualification, outreach, and assistant-driven execution.

The repo contains one core backend application plus assistant adapters, narrative layers, and standalone utility tooling. The main organization problem was not multiple disconnected apps. It was that the docs had drifted and the support tooling had flattened into one layer. This document reflects the repo as it exists now.

## Sources Of Truth

| Layer | Authority | Notes |
| --- | --- | --- |
| Structured state | PostgreSQL | Properties, entities, buyer profiles, seller profiles, knowledge entries, matches, deals, property documents, wiki queue state |
| Semantic recall | ChromaDB | Embeddings and semantic search backing knowledge retrieval |
| Narrative evidence | `raw/` | Immutable source files cited from the wiki |
| Narrative synthesis | `wiki/` | Human-readable broker pages that must not override the database |

`wiki/` is downstream of the core brain. It is not the system of record.

## Architecture In One View

```text
                +------------------------------+
                | API / CLI / MCP / Telegram   |
                | Hermes / Omi / Vermes ingress|
                +--------------+---------------+
                               |
                 +---------v---------+
                 | Application        |
                 | Services /         |
                 | Workflows          |
                 | ingest/import/wiki |
                 +---------+----------+
                          |
      +-------------------+-------------------+
      |                   |                   |
+-----v------+    +-------v-------+    +------v------+
| Core Brain |    | Derived       |    | Narrative   |
| Domains    |    | Intelligence  |    | Layer       |
| entities   |    | distress      |    | raw + wiki  |
| properties |    | motivation    |    |             |
| buyers     |    | matching      |    +-------------+
| sellers    |    | portfolio     |
| knowledge  |    | analytics     |
+-----+------+    +-------+-------+
      |                   |
      +---------+---------+
                |
         +------v------+
         | Postgres    |
         | ChromaDB    |
         +-------------+
```

## Code Organization

### Core Brain Domains

These directories represent the actual business brain:

| Directory | Responsibility |
| --- | --- |
| `src/entities` | Canonical people, LLC, lender, trustee, and relationship identity graph |
| `src/properties` | Canonical property records, parcel grouping, and attached document handling |
| `src/buyers` | Buyer profiles, history, and lender-oriented buyer analytics |
| `src/sellers` | Seller profiles plus distress and motivation signals |
| `src/knowledge` | Unstructured notes, transcripts, document summaries, embeddings, and search |
| `src/matching` | Buyer-seller-property scoring, persistence, explanations, and narratives |

### Brain Write And Enrichment Workflows

These directories are part of the write path into the brain:

| Directory | Responsibility |
| --- | --- |
| `src/app` | Shared application-service layer used by API, CLI, MCP, Telegram, and channel adapters |
| `src/ingestion` | Conversational classification and routing into structured records |
| `src/import-export/foreclosure-import.js` | Business-specific foreclosure import workflow |
| `src/knowledge/transcribe.js` | Audio-to-text ingestion entry point |
| `src/properties/documents.js` | Property evidence ingestion with knowledge and wiki hooks |
| `src/entities/resolve-llc.js` | External enrichment for LLC resolution |

### Support Infrastructure

These directories enable the brain but are not themselves business domains:

| Directory | Responsibility |
| --- | --- |
| `src/db` | Pooling, schema, migrations |
| `src/inference` | LLM provider abstraction |
| `src/import-export/gateway.js` | Generic CSV, XLSX, and JSON file parsing |
| `src/integrations` | External service adapters such as Telegram, Gmail, Obsidian, RealNex, Hermes, and Omi |
| `src/ops` | Long-running workers and operational entry points over the shared app layer |
| `src/utils` | Shared utility helpers |

### Delivery Surfaces

These are the user-facing or operator-facing entry points:

| Surface | Files | Notes |
| --- | --- | --- |
| HTTP API | `src/api` | Primary runtime surface |
| CLI | `src/cli/brain.js` | Operator and broker-facing adapter over shared app services plus wiki commands |
| MCP | `src/mcp` | Assistant tool adapter over shared app services |
| Telegram bot | `src/ops/telegram-bot.js` | Chat front door with command and plain-text intent routing |
| Channel ingress | `src/api/routes/channels.js` | Hermes, Omi, and Vermes webhook-style ingress |
| Ops scripts | `scripts/` | Support setup, import, maintenance, and QA |

## Runtime Surfaces

### API

The Express server in `src/api/server.js` mounts route families for:

- health
- answer
- ingest
- search
- entities
- buyers
- sellers
- knowledge
- properties
- matching
- daily
- import/export
- realnex
- channels

`/api/*` is the real working surface. `/brain/*` is a mixed compatibility layer: some routes still proxy real behavior and some remain placeholders. It should not be treated as the canonical product API.

Protected write surfaces fail closed unless explicit secrets are configured. Administrative routes use `ADMIN_API_KEY`. Channel ingress uses route-specific shared secrets instead of a global admin fallback.

### Compatibility And Legacy Surface

The compatibility story is intentionally narrow:

- `/api/*` is canonical.
- public deploys may reverse-proxy the app under `/api/brain/*`
- direct `/brain/*` routes exist only as a compatibility fragment for older clients

Current direct `/brain/*` reality:

- live compatibility shims: `answer`, `ingest`, `search`, `daily`, `match`, `entity`
- explicit deprecations: `import`, `export`

The repo should not add new product behavior under direct `/brain/*`. New capability belongs under `/api/*`, with compatibility shims added only when required.

### CLI

`brain` is a thin adapter over the API for the core actions:

- `add`
- `answer`
- `search`
- `lookup`
- `match`
- `daily`

It also owns local narrative operations:

- `promote`
- `promote-document`
- `autopromote`
- `lint`
- `serve`

### MCP

The MCP server currently exposes these operator tools:

- `brain_answer`
- `brain_add`
- `brain_search`
- `brain_lookup`
- `brain_match`
- `brain_daily`
- `brain_status`
- `brain_realnex_disambiguate`

These call shared app services by default and can fall back to HTTP when `BRAIN_TRANSPORT=http`. MCP is an adapter, not a separate backend.

The operator contract for assistants lives in `CLAUDE_SKILL.md` and the assistant sections of `AGENTS.md` / `CLAUDE.md`. The short version is: `brain_answer` is the default conversational front door, specialist tools remain available for deterministic operations, and `brain_add` stays reserved for explicit memory writes.

Today `brain_answer` is best described as a single-turn intent router with a few enrichment fallbacks, not a general multi-step broker agent. The docs and operator expectations should stay aligned with that reality until a planner/executor layer exists above it.

### Telegram

Telegram is a broker-facing front door, not a separate brain:

- slash commands map into the shared assistant service
- plain text is routed through the same shared assistant service
- explicit save requests still flow into note ingestion
- the bot should not be treated as a generic open-ended chatbot unless the routing layer is upgraded further

### Runtime State And Ops Artifacts

Runtime state and operational artifacts live outside the durable domain model:

| Path | Purpose | Notes |
| --- | --- | --- |
| `data/telegram-bot-offset.json` | Telegram polling checkpoint | runtime state, not business truth |
| `data/propertyradar-feed-state.json` | PropertyRadar Gmail checkpoint state | runtime state, not business truth |
| PM2 logs | operational diagnostics | clear or rotate routinely; do not treat as product data |
| deploy finisher output | deployment diagnostics | useful for ops, not for product truth |

These files should stay out of the narrative layer and out of source-of-truth discussions.

## Operational Layout

`scripts/` is now grouped by intent:

| Directory | Purpose | Current scripts |
| --- | --- | --- |
| `scripts/admin` | bootstrap and local environment setup | `migrate.js`, `seed-test-data.js`, `dev-runtime.js`, `auth-gmail-pkce.js` |
| `scripts/imports` | inbound data ingestion | `import-foreclosure-csv.js`, `import-from-realestatetool.js`, `transcribe-folder.js`, `sync-propertyradar-alerts.js` |
| `scripts/ops` | recurring operational tasks | `run-matching.js`, `score-sellers.js`, `run-wiki-maintenance.js`, `run-telegram-bot.js`, `run-propertyradar-feed.js`, `publish-obsidian-note.js`, `telegram-probe.js` |
| `scripts/qa` | verification and sweep tools | `run-ioc-sweep.js` |

`briefs/` is also grouped by intent:

| Directory | Purpose |
| --- | --- |
| `briefs/modules` | implementation briefs and historical module plans |
| `briefs/reports` | generated or point-in-time reports |
| `briefs/prompts` | operator and audit prompts |

## Standalone Utility Tooling

`tools/` is intentionally outside the live runtime. It contains investigative, one-off, or batch utilities that can graduate into `src/` later but are not booted by the API or PM2 stack today.

| Directory | Purpose | Runtime status |
| --- | --- | --- |
| `tools/broker-email-lookup` | one-off broker email enrichment and export workflow | standalone utility |
| `tools/llc-manager-finder` | LLC manager discovery, contact hunting, and optional CRM import | standalone utility |
| `tools/realnex-crm` | Python RealNex client plus CRM dump for batch workflows | standalone utility |

If a tool becomes part of the product, its adapter belongs under `src/integrations`, its orchestration under `src/app`, and its runtime entry points under `src/api`, `src/cli`, `src/mcp`, or `src/ops`.

Generated exports under `tools/` are not authoritative product data. They should be treated as transient artifacts and moved to private storage if they need to persist.

## Major Data Flows

### 1. Conversational Ingestion

```text
message or audio
  -> classify intent
  -> resolve and merge entities
  -> create or update buyer/seller/property context
  -> create knowledge entry
  -> write embedding to ChromaDB
  -> optionally refresh matching
```

This is the fastest path for broker knowledge entering the system.

### 2. Foreclosure Import

```text
CSV/XLSX file
  -> import-export gateway
  -> foreclosure-specific normalization and dedupe
  -> property upsert
  -> entity extraction and linking
  -> seller profile generation
  -> ready for distress scoring and matching
```

This is the highest-signal structured import path for distressed inventory.

### 3. Property Document Promotion

```text
document upload
  -> property attachment
  -> knowledge entry
  -> raw evidence reference
  -> optional wiki queue / promotion
```

This connects evidence handling with the narrative layer without making the wiki authoritative.

## Repo Layout

```text
.
├── src/
│   ├── api/
│   ├── app/
│   ├── buyers/
│   ├── cli/
│   ├── db/
│   ├── entities/
│   ├── import-export/
│   ├── inference/
│   ├── ingestion/
│   ├── integrations/
│   ├── knowledge/
│   ├── matching/
│   ├── mcp/
│   ├── ops/
│   ├── properties/
│   ├── sellers/
│   ├── utils/
│   └── wiki/
├── scripts/
│   ├── admin/
│   ├── imports/
│   ├── ops/
│   └── qa/
├── tests/
│   ├── integration/
│   └── unit/
├── tools/
├── raw/
├── wiki/
└── briefs/
    ├── modules/
    ├── prompts/
    └── reports/
```

## Current Rough Edges

The repo is better organized now, but some architectural blur remains:

- API route files still contain some direct SQL and response shaping instead of calling a dedicated application-service layer.
- `src/ingestion/router.js` coordinates too many cross-domain side effects.
- `src/properties/documents.js` and `src/knowledge/transcribe.js` are cross-cutting modules that touch both core and narrative workflows.
- Matching currently reaches into knowledge retrieval directly instead of depending on a narrower scoring input contract.
- Telegram plain-text handling is now safer, but it is still an intent router over the brain, not a fully conversational agent shell.
- `tools/` still contains bulky exports and utility code that should be treated as sensitive operational material even when they are not part of the live runtime.
- The migration set in `src/db/migrations/` is the live schema contract; `src/db/schema.sql` is a base scaffold, not the full source of truth.

## Directional Cleanup

The application layer now exists in `src/app/`, but not every route family has been fully pulled through it yet. Buyers, sellers, properties, knowledge, and import/export are still partially hybrid.
