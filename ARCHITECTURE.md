# Sullivan Link Brain Architecture

## Purpose

Sullivan Link Brain is a local-first commercial real estate intelligence backend. Its job is to turn distressed-property signals and broker knowledge into a usable operating system for sourcing, qualification, and outreach.

The repo contains one core backend application plus supporting narrative, operational, and verification layers. The main organization problem was not multiple disconnected apps. It was that the docs had drifted and the support tooling had flattened into one layer. This document reflects the repo as it exists now.

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
                +-------------------+
                |   API / CLI / MCP |
                +---------+---------+
                          |
                 +--------v--------+
                 | Application     |
                 | Workflows       |
                 | ingest/import/  |
                 | documents/wiki  |
                 +--------+--------+
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
| `src/integrations` | External service adapters |
| `src/utils` | Shared utility helpers |

### Delivery Surfaces

These are the user-facing or operator-facing entry points:

| Surface | Files | Notes |
| --- | --- | --- |
| HTTP API | `src/api` | Primary runtime surface |
| CLI | `src/cli/brain.js` | Thin operator and broker-facing adapter over the API plus wiki commands |
| MCP | `src/mcp` | Five MCP tools that proxy to the API |
| Ops scripts | `scripts/` | Support setup, import, maintenance, and QA |

## Runtime Surfaces

### API

The Express server in `src/api/server.js` mounts route families for:

- health
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

`/api/*` is the real working surface. Legacy `/brain/*` routes are stubs or compatibility placeholders and should not be treated as the product API.

### CLI

`brain` is a thin adapter over the API for the core actions:

- `add`
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

The MCP server exposes five tools:

- `brain_add`
- `brain_search`
- `brain_lookup`
- `brain_match`
- `brain_daily`

These proxy back to the HTTP API. MCP is an adapter, not a separate backend.

## Operational Layout

`scripts/` is now grouped by intent:

| Directory | Purpose | Current scripts |
| --- | --- | --- |
| `scripts/admin` | bootstrap and local environment setup | `migrate.js`, `seed-test-data.js` |
| `scripts/imports` | inbound data ingestion | `import-foreclosure-csv.js`, `import-from-realestatetool.js`, `transcribe-folder.js`, `sync-propertyradar-alerts.js` |
| `scripts/ops` | recurring operational tasks | `run-matching.js`, `score-sellers.js`, `run-wiki-maintenance.js` |
| `scripts/qa` | verification and sweep tools | `run-ioc-sweep.js` |

`briefs/` is also grouped by intent:

| Directory | Purpose |
| --- | --- |
| `briefs/modules` | implementation and module briefs |
| `briefs/reports` | generated or point-in-time reports |
| `briefs/prompts` | operator and audit prompts |

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
- The migration set in `src/db/migrations/` is the live schema contract; `src/db/schema.sql` is a base scaffold, not the full source of truth.

## Directional Cleanup

If the team keeps expanding this repo, the next structural step should be an explicit application layer, for example `src/app/` or `src/services/`, so API, CLI, MCP, and scripts all depend on the same use-case boundary instead of partially re-implementing orchestration in multiple places.
