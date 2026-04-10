# Sullivan Link Brain

Sullivan Link Brain is the backend and broker memory system behind Sullivan Link. It ingests distressed commercial real estate signals, turns them into structured intelligence, and gives the team three working surfaces on top of the same core brain: an API, a CLI, and an MCP server.

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
- Ops scripts: grouped under `scripts/admin`, `scripts/imports`, `scripts/ops`, and `scripts/qa`

API, CLI, and MCP all sit on top of the same `src/` codebase. The scripts are support tools for setup, imports, maintenance, and verification.

## Repo Map

```text
src/
  api/            HTTP routes and request validation
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
  mcp/            MCP tool adapter over the API
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
docker-compose up -d
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

## Common Workflows

Run the core runtime surfaces:

```bash
npm start
brain search "industrial Carson"
brain match "Mike Chen"
brain serve
```

Import or enrich data:

```bash
node scripts/imports/import-foreclosure-csv.js /path/to/foreclosures.csv --dry-run
node scripts/imports/import-from-realestatetool.js --region la_county --limit 100
node scripts/imports/transcribe-folder.js /path/to/voice-memos --once
```

Run operational maintenance:

```bash
npm run match
node scripts/ops/score-sellers.js --report
npm run wiki:maintain
node scripts/qa/run-ioc-sweep.js
```

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
- `briefs/` is design/history context, not executable truth.
- `ARCHITECTURE.md` explains the current boundaries between core brain domains, workflows, delivery surfaces, and support tooling.
