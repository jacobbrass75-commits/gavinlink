# ISG Second Brain -- Architecture

> Milestone: Modules 1-4 complete. 49/49 tests passing.
> Last updated: 2026-04-06

## What This Is

ISG Second Brain is the data intelligence backend for Sullivan Link -- a commercial real estate foreclosure platform. It ingests property records, extracts entities (owners, trustees, lenders), builds buyer and seller profiles, scores distress, and infers seller motivation using LLMs.

**Stack:** Node.js 20+ / Express / PostgreSQL 16 / ChromaDB / Claude|OpenAI|Ollama

---

## System Overview

```
+------------------+     +------------------+     +-----------------+
|  RealEstateTool  |     |  CSV / XLSX /    |     |  Manual Entry   |
|  (MCP / HTTP)    |     |  JSON Files      |     |  (API)          |
+--------+---------+     +--------+---------+     +--------+--------+
         |                         |                        |
         +------------+------------+------------------------+
                      |
              +-------v--------+
              |   Import       |
              |   Pipeline     |
              |  (gateway.js)  |
              +-------+--------+
                      |
         +------------v--------------+
         |                           |
   +-----v------+           +-------v--------+
   | Entity      |           | Property       |
   | Extraction  |           | Upsert         |
   | (extract,   |           | (apn+region    |
   |  classify,  |           |  dedup)        |
   |  normalize) |           +-------+--------+
   +-----+------+                   |
         |                          |
   +-----v------+           +------v---------+
   | LLC         |           | Seller Auto-   |
   | Resolution  |           | Generation     |
   | (SoS, graph |           | (one profile   |
   |  traversal) |           |  per property) |
   +-----+------+           +------+---------+
         |                          |
   +-----v------+           +------v---------+
   | Entity      |           | Distress       |
   | Clustering  |           | Scoring &      |
   | (pg_trgm    |           | Foreclosure    |
   |  dedup)     |           | Classification |
   +-------------+           +------+---------+
                                    |
                             +------v---------+
                             | AI Motivation  |
                             | Inference      |
                             | (Claude/GPT)   |
                             +----------------+

         +-----------------------------------------------+
         |              Express API (port 3100)           |
         |                                                |
         |  /health    /api/entities   /api/buyers        |
         |  /api/sellers              /api/lenders        |
         +-----------------------------------------------+
                              |
         +--------------------v--------------------------+
         |             PostgreSQL 16 (port 5433)          |
         |  entities, properties, buyer_profiles,         |
         |  seller_profiles, matches, deals,              |
         |  knowledge_entries, entity_relationships       |
         +-----------------------+-----------------------+
                                 |
         +-----------------------v-----------------------+
         |           ChromaDB (port 8000)                 |
         |     (vector embeddings -- reserved,            |
         |      not yet populated)                        |
         +-----------------------------------------------+
```

---

## Module Breakdown

### Module 1 -- Infrastructure Scaffold

Foundation layer. Database, API server, migrations, import parsing, inference abstraction.

| Component | File | Purpose |
|-----------|------|---------|
| API Server | `src/api/server.js` | Express app factory, route registration, port 3100 |
| DB Connection | `src/db/connection.js` | Singleton `pg.Pool`, `query()` helper, `close()` teardown |
| Migrations | `scripts/migrate.js` | Reads `src/db/migrations/*.sql` in order, tracks in `_migrations` table |
| Seed Data | `scripts/seed-test-data.js` | 10 test properties across LA County with varied distress profiles |
| Health Check | `src/api/routes/health.js` | DB connectivity, table count, ChromaDB ping, inference provider status |
| Import Gateway | `src/import-export/gateway.js` | Parses CSV, XLSX, JSON into uniform `{rows, columns, format}` |
| Inference Provider | `src/inference/provider.js` | Pluggable LLM: Claude (Anthropic SDK), OpenAI, or Ollama. Single `complete(system, user)` interface |
| Docker | `docker-compose.yml` | PostgreSQL 16 + ChromaDB containers with persistent volumes |

**Core Schema (001_core_tables.sql):** 8 tables, 10 indexes, pg_trgm extension for fuzzy search.

### Module 2 -- Entity Extraction Pipeline

Turns raw property records into a structured entity graph.

| Component | File | Purpose |
|-----------|------|---------|
| Extraction | `src/entities/extract.js` | `normalizeName()` uppercase/whitespace normalization. `classifyEntityType()` regex classification: LLC, corporation, trust, partnership, lender, person |
| Clustering | `src/entities/cluster.js` | Recursive CTE graph traversal (max depth 5) with cycle protection. `getPortfolio()` returns all properties reachable through entity relationships |
| LLC Resolution | `src/entities/resolve-llc.js` | CA Secretary of State lookup (when `CA_SOS_SEARCH_URL` configured). Creates entity relationships with confidence scores. Falls back gracefully |
| RealEstateTool | `src/integrations/realestatetool.js` | HTTP client for live property imports. Region-scoped. Pagination support. Maps external fields to internal schema |
| Import Script | `scripts/import-from-realestatetool.js` | CLI: `--region`, `--csv` fallback. Upserts properties by `(apn, region)`, extracts entities, links FKs |
| Migration 002 | `src/db/migrations/002_...sql` | Adds `beneficiary_name`, `lender_entity_id`, `loan_amount`, `ltv`, `equity_amount`, `equity_percent`, `default_amount`, `default_date`, `realestatetool_id`, `ai_summary` to properties |

**Entity Classification Rules:**
```
/L\.?L\.?C\.?/           -> llc
/INC|CORP/               -> corporation
/TRUST|TRUSTEE/          -> trust
/L\.?P\.?|PARTNERS?/     -> partnership
/BANK|LENDING|MORTGAGE/  -> lender (only from trustee/beneficiary fields)
everything else          -> person
```

**Graph Traversal:** Recursive CTE walks `entity_relationships` parent->child up to 5 levels deep. Cycle-safe via path array exclusion.

### Module 3 -- Buyer Intelligence Engine

Buyer profiles, purchase history, lender aggregation. Pure SQL, no LLM calls.

| Component | File | Purpose |
|-----------|------|---------|
| Profiles | `src/buyers/profiles.js` | CRUD with pg_trgm fuzzy entity matching on create. Array field merge on update. `sensibilities` appends with `[YYYY-MM-DD]` timestamps. Purchase history tracking |
| Activity | `src/buyers/activity.js` | Log buyer interactions. Activity timeline queries |
| Lender Reports | `src/buyers/lender-report.js` | SQL aggregation: lender rankings by property count, overlap detection between lenders sharing properties |
| Routes | `src/api/routes/buyers.js` | Full REST: POST/GET/PUT/DELETE buyers, POST/GET purchases, GET stats, GET lenders |
| Migration 003 | `src/db/migrations/003_...sql` | Adds `active`, `target_cities`, `target_zip_codes`, `min_cap_rate`, `investment_strategy`, `financing_preference`, `typical_close_timeline`, `urgency`, `sensibilities` to buyer_profiles. Creates `buyer_purchases` table |

**Buy Box Criteria:** property type, markets, cities, zip codes, price range, sqft range, lot size range, unit count, cap rate floor, investment strategy, financing preference, close timeline, urgency level.

### Module 4 -- Seller Intelligence Engine

Auto-generated seller profiles from property data. Distress scoring. AI motivation inference.

| Component | File | Purpose |
|-----------|------|---------|
| Profiles | `src/sellers/profiles.js` | Auto-generate one seller profile per foreclosed property. CRUD, search, filtering by distress/motivation/stage/city. Distribution stats |
| Distress Score | `src/sellers/distress-score.js` | Deterministic 1-5 score. Batch scoring with property context enrichment |
| Foreclosure Stage | `src/sellers/foreclosure-stage.js` | Date-driven classification: none -> pre_foreclosure -> NOD -> NTS -> auction_pending -> REO |
| Motivation | `src/sellers/motivation.js` | LLM-powered inference via inference provider. Structured JSON output. Graceful fallback to `unknown` on failure |
| Portfolio Distress | `src/sellers/portfolio-distress.js` | SQL: entities with 2+ distressed properties. Lender concentration patterns |
| Score Script | `scripts/score-sellers.js` | CLI: batch score all unscored seller profiles |
| Routes | `src/api/routes/sellers.js` | GET/PUT sellers, POST auto-generate/score/infer, GET distressed/lender-patterns/distribution |
| Migration 004 | `src/db/migrations/004_...sql` | Adds `active`, `motivation`, `distress_level`, `timeline`, `foreclosure_stage`, `outstanding_debt`, `estimated_equity`, `minimum_acceptable`, `lender_status`, `legal_issues`, `sensibilities`, `approach_suggestions`, `ai_reasoning`, `scored_at`, `inferred_at` to seller_profiles |

**Distress Scoring Algorithm:**
```
Points (additive, clamped to 1-5):
  +1.0  foreclosure flag
  +1.0  LTV > 80%
  +1.0  default/assessed ratio > 10%
  +1.0  owner-occupied
  +1.0  default age > 180 days (stale)
  +0.5  equity < 20%
  +0.5  owner has 2+ foreclosures (portfolio distress)

Bonus (only if base score <= 1 AND foreclosure = true):
  +0.5  active trustee phone on file
  +0.5  assessed value >= $10M
  +0.5  sqft >= 50,000 OR units >= 50

Result: round(points) clamped to [1, 5]
Flags: array of triggered conditions
```

**Foreclosure Stage Classification:**
```
not foreclosure         -> "none"
has sale_date           -> "reo"
has default_date:
  age <= 90 days        -> "notice_of_default"
  age <= 180 days       -> "notice_of_sale"
  age > 180 days        -> "auction_pending"
titlepro no_recording   -> "pre_foreclosure"
else                    -> "unknown"
```

**Default Timeline Mapping:**
```
auction_pending/reo OR distress >= 4  -> "urgent"
notice_of_sale                        -> "30_days"
notice_of_default                     -> "60_days"
pre_foreclosure                       -> "90_days"
else                                  -> "flexible"
```

**AI Motivation Inference:**
Sends property data + portfolio context to LLM. Expects structured JSON:
```json
{
  "motivation": "foreclosure|estate|retirement|...|unknown",
  "distress_level": 1-5,
  "likely_timeline": "urgent|30_days|60_days|90_days|flexible",
  "lender_status": "cooperating|non_responsive|pursuing_foreclosure|open_to_short_sale|unknown",
  "reasoning": "2-3 sentence explanation",
  "approach_suggestions": ["suggestion 1", "suggestion 2"]
}
```
Falls back to `DEFAULT_RESULT` (motivation=unknown, distress=1) on any provider failure.

---

## Database Schema

### Tables

| Table | Records | Purpose |
|-------|---------|---------|
| `entities` | People, LLCs, trusts, corporations, lenders, trustees, brokers, partnerships | Central identity store |
| `entity_relationships` | Parent-child links with relationship type and confidence | LLC membership, registered agents, lender connections |
| `properties` | Real estate assets with APN, financials, foreclosure data | Core property records |
| `buyer_profiles` | Linked to entity. Buy-box criteria, investment strategy, urgency | Buyer account management |
| `buyer_purchases` | Purchase history per buyer | Transaction history |
| `seller_profiles` | One per property. Distress score, motivation, foreclosure stage | Seller opportunity tracking |
| `knowledge_entries` | Call transcripts, notes, emails, documents | Unstructured intelligence |
| `matches` | Buyer-seller-property triples with score and status | Matching engine output (not yet populated) |
| `deals` | Transaction lifecycle: prospect -> LOI -> under_contract -> closed | Deal tracking |
| `_migrations` | Migration filenames and timestamps | Schema versioning |

### Key Relationships

```
entities 1--* entity_relationships (parent or child)
entities 1--1 buyer_profiles
entities 1--* seller_profiles
entities 1--* properties (as owner, trustee, or lender)
properties 1--1 seller_profiles
properties 1--* matches
buyer_profiles 1--* buyer_purchases
buyer_profiles 1--* matches
seller_profiles 1--* matches
matches *--1 deals
```

### Indexes

- **Fuzzy search:** GIN trigram on `entities.normalized_name` and `properties.address`
- **Filtering:** Composite indexes on `(region, foreclosure)`, `(city, state)`, `(status, score DESC)`
- **Partial indexes:** `buyer_profiles(active) WHERE active=TRUE`, `seller_profiles(distress_level) WHERE active=TRUE`, `properties(foreclosure) WHERE foreclosure=TRUE`
- **FK lookups:** Indexes on all foreign key columns

---

## API Reference

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | DB, ChromaDB, inference provider status. 200 or 503 |

### Entities (Module 2)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/entities` | List. `?type=llc&limit=25&offset=0` |
| GET | `/api/entities/search` | Fuzzy search. `?q=smith&limit=25` |
| GET | `/api/entities/distressed` | Entities with 2+ foreclosed properties |
| GET | `/api/entities/:id` | Detail with relationships and properties |
| GET | `/api/entities/:id/portfolio` | All properties reachable via entity graph |

### Buyers (Module 3)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/buyers` | Create profile. Fuzzy-matches or creates entity |
| GET | `/api/buyers` | List. `?property_type=&city=&strategy=&urgency=` |
| GET | `/api/buyers/search` | Fuzzy search. `?q=` |
| GET | `/api/buyers/:id` | Detail with entity and stats |
| PUT | `/api/buyers/:id` | Update. Merges arrays, appends sensibilities |
| DELETE | `/api/buyers/:id` | Soft-delete (sets active=false) |
| POST | `/api/buyers/:id/purchases` | Record a purchase |
| GET | `/api/buyers/:id/purchases` | Purchase history |
| GET | `/api/buyers/:id/stats` | Aggregate purchase stats |
| GET | `/api/lenders` | Lender rankings by property count |
| GET | `/api/lenders/:id` | Lender detail with properties |
| GET | `/api/lenders/overlaps` | Lenders sharing properties |

### Sellers (Module 4)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sellers` | List. `?min_distress=&motivation=&foreclosure_stage=&city=&sort_by=` |
| GET | `/api/sellers/search` | Fuzzy search. `?q=` |
| GET | `/api/sellers/:id` | Detail with property and entity |
| GET | `/api/sellers/by-property/:propertyId` | Lookup by property |
| PUT | `/api/sellers/:id` | Update profile fields |
| POST | `/api/sellers/auto-generate` | Create profiles for all foreclosed properties |
| POST | `/api/sellers/score` | Batch distress scoring. `?limit=&rescore=true` |
| POST | `/api/sellers/infer` | Batch AI motivation inference. `?limit=5` |
| GET | `/api/sellers/distressed` | Portfolio-level distress (multi-property owners) |
| GET | `/api/sellers/lender-patterns` | Lender concentration patterns |
| GET | `/api/sellers/distribution` | Status/distress/stage/motivation breakdowns |

### Stubbed (Module 2 placeholders -- not yet implemented)
| Method | Path | Status |
|--------|------|--------|
| GET | `/brain/match/:identifier` | 501 -- planned for matching engine |
| GET | `/brain/daily` | 501 -- planned for daily digest |
| POST | `/brain/import` | 501 -- planned for bulk import |
| GET | `/brain/export` | 501 -- planned for bulk export |

---

## Environment Variables

```bash
# PostgreSQL
POSTGRES_HOST=localhost        # default: localhost
POSTGRES_PORT=5433             # default: 5433 (avoids local Postgres collision)
POSTGRES_DB=isg_brain
POSTGRES_USER=isg
POSTGRES_PASSWORD=localdev

# ChromaDB (vector store -- reserved)
CHROMA_HOST=localhost
CHROMA_PORT=8000

# LLM Inference
INFERENCE_PROVIDER=claude      # claude | openai | ollama
ANTHROPIC_API_KEY=             # required if claude
OPENAI_API_KEY=                # required if openai
OLLAMA_HOST=http://localhost:11434

# External Services
REALESTATETOOL_URL=            # live property import endpoint
CA_SOS_SEARCH_URL=             # California Secretary of State LLC lookup

# Server
API_PORT=3100
```

---

## Scripts

| Script | Usage | Description |
|--------|-------|-------------|
| `scripts/migrate.js` | `npm run migrate` | Apply pending SQL migrations |
| `scripts/seed-test-data.js` | `npm run seed` | Insert 10 test properties |
| `scripts/import-from-realestatetool.js` | `node scripts/import-from-realestatetool.js --region la_county` | Import properties from RealEstateTool or CSV fallback |
| `scripts/score-sellers.js` | `node scripts/score-sellers.js` | Batch distress-score all unscored seller profiles |

---

## Test Coverage

49 tests across 9 test files. All passing.

| File | Type | Tests | Covers |
|------|------|-------|--------|
| `tests/unit/connection.test.js` | Unit | 4 | Pool singleton, query execution, teardown, env config |
| `tests/unit/provider.test.js` | Unit | ~4 | Inference provider selection, completion interface |
| `tests/unit/extract.test.js` | Unit | ~8 | Name normalization, entity type classification |
| `tests/unit/cluster.test.js` | Unit | ~8 | Graph traversal, portfolio aggregation |
| `tests/unit/buyer-profiles.test.js` | Unit | ~6 | Profile CRUD, array merge, sensibility append |
| `tests/unit/lender-report.test.js` | Unit | ~6 | Lender aggregation, overlap detection |
| `tests/unit/distress-score.test.js` | Unit | ~6 | Score calculation, flag detection, edge cases |
| `tests/unit/foreclosure-stage.test.js` | Unit | ~4 | Stage classification by date ranges |
| `tests/integration/db-setup.test.js` | Integration | ~3 | Migration application, table creation |
| `tests/integration/entity-pipeline.test.js` | Integration | ~5 | End-to-end entity extraction and linking |
| `tests/integration/buyer-pipeline.test.js` | Integration | ~5 | Buyer creation, purchase recording, lender reports |
| `tests/integration/seller-pipeline.test.js` | Integration | ~8 | Auto-generation, scoring, inference mock, distribution |

---

## File Tree

```
isg-second-brain/
  docker-compose.yml
  package.json
  .env.example
  README.md
  ARCHITECTURE.md

  briefs/
    02-entities.md
    03-buyer-intel.md
    04-seller-intel.md

  scripts/
    migrate.js
    seed-test-data.js
    import-from-realestatetool.js
    score-sellers.js

  src/
    api/
      server.js
      routes/
        health.js
        ingest.js              (stub)
        search.js              (stub)
        entities.js
        buyers.js
        sellers.js
        match.js               (stub)
        daily.js               (stub)
        import-export.js       (stub)

    db/
      connection.js
      schema.sql
      migrations/
        001_core_tables.sql
        002_realestatetool_entity_fields.sql
        003_buyer_enhancements.sql
        004_seller_enhancements.sql

    entities/
      extract.js
      cluster.js
      resolve-llc.js

    integrations/
      realestatetool.js

    buyers/
      profiles.js
      activity.js
      lender-report.js

    sellers/
      profiles.js
      distress-score.js
      foreclosure-stage.js
      motivation.js
      portfolio-distress.js

    import-export/
      gateway.js

    inference/
      provider.js

  tests/
    fixtures/
      sample-properties.json
    unit/
      connection.test.js
      provider.test.js
      extract.test.js
      cluster.test.js
      buyer-profiles.test.js
      lender-report.test.js
      distress-score.test.js
      foreclosure-stage.test.js
    integration/
      db-setup.test.js
      entity-pipeline.test.js
      buyer-pipeline.test.js
      seller-pipeline.test.js
```

---

## Git History

```
3a08a5e feat(module-04): implement seller intelligence engine
7543236 test(modules-1-3): full integration verification passed 49/49
b1868cc feat(module-03): implement buyer intelligence engine
951129a feat(module-02): implement entity extraction pipeline
554c07f fix(module-01): align Docker postgres port defaults
cd5662a module 1 infrastructure scaffold
```

Branch: `module/04-seller-intel`

---

## What's Next

The following capabilities are stubbed but not implemented:

1. **Matching Engine** (`/brain/match/:identifier`) -- Score buyer-seller-property triples using buy-box criteria against seller/property attributes
2. **Daily Digest** (`/brain/daily`) -- Summarize new properties, score changes, approaching auction dates
3. **Bulk Import/Export** (`/brain/import`, `/brain/export`) -- Full dataset import/export beyond the current file-level gateway
4. **ChromaDB Integration** -- Vector embeddings for semantic search across knowledge_entries
5. **Knowledge Entry API** -- CRUD for call transcripts, notes, market insights
6. **Deal Pipeline** -- Full deal lifecycle tracking from match to close
