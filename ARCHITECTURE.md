# ISG Second Brain -- Architecture

> Modules 1-6 built. Wiki narrative layer operational. Matching engine scoring 1,952 matches.
> Last updated: 2026-04-06

## What This Is

ISG Second Brain is the data intelligence backend for Sullivan Link -- a commercial real estate foreclosure platform. It ingests property records, extracts entities (owners, trustees, lenders), builds buyer and seller profiles, scores distress, infers seller motivation using LLMs, and runs a weighted matching engine to pair buyers with seller opportunities. A Karpathy-style wiki narrative layer synthesizes knowledge for broker meeting prep.

**Stack:** Node.js 20+ / Express / PostgreSQL 16 / ChromaDB / Claude|OpenAI|Ollama

**Current Data:**

| Table | Records |
|-------|---------|
| properties | 681 |
| entities | 495 |
| seller_profiles | 673 |
| buyer_profiles | 3 |
| matches | 1,952 |

---

## System Overview

```
+------------------+     +------------------+     +-----------------+     +-----------------+
|  MCP Server      |     |  CLI (brain)     |     |  Express API    |     |  CSV Import     |
|  (5 tools)       |     |  add/search/     |     |  (port 3100)    |     |  Script         |
|  stdio transport |     |  match/daily/    |     |  56 routes      |     |  (UTF-16 aware) |
|                  |     |  promote/lint    |     |  rate-limited   |     |                 |
+--------+---------+     +--------+---------+     +--------+--------+     +--------+--------+
         |                         |                        |                       |
         +------------+------------+------------------------+-----------------------+
                      |
              +-------v--------+
              |   Ingestion    |
              |   Pipeline     |
              |   (classify +  |
              |    validate)   |
              +-------+--------+
                      |
         +--+---------+----------+--+
         |  |                    |  |
   +-----v--v---+       +-------v--v-----+
   | Entity      |       | Property       |
   | Extraction  |       | Upsert         |
   | + Classify  |       | (apn+region    |
   | + Normalize |       |  dedup)        |
   | + Merge     |       | + Documents    |
   +-----+------+       | + Grouping     |
         |              +-------+--------+
   +-----v------+               |
   | Knowledge   |       +-------v--------+
   | Entry +     |       | Seller Auto-   |
   | Embedding   |       | Generation     |
   +-----+------+       | + Distress     |
         |              |   Scoring      |
   +-----v------+       +-------+--------+
   | ChromaDB    |               |
   | (semantic   |       +------v---------+
   |  vectors)   |       | Matching       |
   +-----+------+       | Engine         |
         |              | (weighted,     |
   +-----v------+       |  0-100)        |
   | Wiki        |       +------+---------+
   | Narrative   |              |
   | Layer       |       +------v---------+
   | (promote +  |       | AI Narrative   |
   |  lint)      |       | Generation     |
   +-------------+       | (score >= 75)  |
                         +----------------+
```

---

## Data Flow: CSV Import Pipeline

The primary import path for production data is the foreclosure CSV importer. The pipeline handles UTF-16 encoded files from the county data vendor.

```
CSV File (UTF-16 LE/BE or UTF-8)
    |
    v
1. Parse (gateway.js)
   - BOM detection: FF FE (UTF-16 LE), FE FF (UTF-16 BE)
   - Null-byte pattern detection for BOM-less UTF-16 LE
   - Byte-swap for UTF-16 BE, decode to string, stream to csv-parser
    |
    v
2. Map + Normalize (import-foreclosure-csv.js)
   - Field mapping: APN, Address, City, Sale Date, Trustee Name,
     Trustee Phone #, Bene/Client Name, Foreclosure Document Type, Use
   - City: title case ("LOS ANGELES" -> "Los Angeles")
   - Phone: (xxx) xxx-xxxx format
   - Trustee: uppercase, strip punctuation, collapse whitespace
   - Beneficiary: filter "NO LENDER ON DOCUMENT", uppercase
   - Sale date: MM/DD/YYYY -> YYYY-MM-DD
   - Address: uppercase, collapse whitespace
   - Skip rows without APN
    |
    v
3. Deduplicate
   - Key: apn:region
   - Conflict: keep row with more data (prefer row with sale date)
    |
    v
4. Upsert Properties
   - INSERT ON CONFLICT (apn, region) DO UPDATE
   - COALESCE: new values fill nulls, never overwrite existing data
   - metadata: JSON merge (existing || new)
   - Wrapped in single transaction (BEGIN/COMMIT/ROLLBACK)
    |
    v
5. Extract + Link Entities
   - processPropertyEntities: extract owner, trustee, beneficiary
   - Classify entity type (LLC, corporation, trust, person, lender)
   - Normalize names, create/link entity records
    |
    v
6. Auto-Generate Seller Profiles
   - One profile per foreclosure property
   - Resolves entity: owner_entity_id -> owner_name lookup -> trustee/lender fallback
   - Computes distress score, foreclosure stage, timeline, equity
   - Graceful skip on entity resolution failure
    |
    v
7. Ready for Matching
   - run-matching.js scores all buyer-seller pairs
```

**Usage:**
```bash
node scripts/import-foreclosure-csv.js data/foreclosures.csv           # live import
node scripts/import-foreclosure-csv.js data/foreclosures.csv --dry-run  # preview only
node scripts/import-foreclosure-csv.js data/foreclosures.csv --limit 50 # first 50 rows
node scripts/import-foreclosure-csv.js data/foreclosures.csv --skip-sellers
```

---

## Module Breakdown

### Module 1 -- Infrastructure Scaffold [COMPLETE]

Foundation layer. Database, API server, migrations, import parsing, inference abstraction, guardrails.

| Component | File | Purpose |
|-----------|------|---------|
| API Server | `src/api/server.js` | Express app, route registration, error handling middleware, port 3100 |
| Guardrails | `src/api/guardrails.js` | IP-based rate limiting (bucket algorithm), admin API key validation |
| Validation | `src/api/validation.js` | Zod schema validation middleware, formatted error responses |
| DB Connection | `src/db/connection.js` | Singleton `pg.Pool`, `query()` helper, `close()` teardown |
| Migrations | `scripts/migrate.js` | Reads `src/db/migrations/*.sql` in order, tracks in `_migrations` |
| Seed Data | `scripts/seed-test-data.js` | 10 test properties across LA County |
| Health Check | `src/api/routes/health.js` | DB connectivity, table count, ChromaDB ping, inference status |
| Import Gateway | `src/import-export/gateway.js` | CSV (UTF-8/16), XLSX, JSON -> uniform `{rows, columns, format}` |
| Inference Provider | `src/inference/provider.js` | Pluggable LLM: Claude, OpenAI, or Ollama. `complete()` + `embed()` |
| SQL Utils | `src/utils/sql.js` | SQL LIKE pattern escaping helpers |
| Docker | `docker-compose.yml` | PostgreSQL 16 + ChromaDB containers |

**Rate Limits:**
- Search: 12/min per IP
- Matching: 6/min per IP
- Narrative generation: 4/min per IP
- Property document uploads: 10/min per IP
- Admin endpoints require `x-api-key` header matching `ADMIN_API_KEY` env var

### Module 2 -- Entity Extraction Pipeline [COMPLETE]

Turns raw property records into a structured entity graph.

| Component | File | Purpose |
|-----------|------|---------|
| Extraction | `src/entities/extract.js` | `normalizeName()`, `classifyEntityType()` regex classification |
| Clustering | `src/entities/cluster.js` | Recursive CTE graph traversal (depth 5), `getPortfolio()`, `detectPortfolioDistress()` |
| LLC Resolution | `src/entities/resolve-llc.js` | CA Secretary of State lookup with confidence scores |
| RealEstateTool | `src/integrations/realestatetool.js` | HTTP client for live property imports |
| Entity Merge | `src/ingestion/merge.js` | Fuzzy matching (pg_trgm), find-or-create, type normalization |

**Entity Classification:** `LLC -> llc`, `INC|CORP -> corporation`, `TRUST|TRUSTEE -> trust`, `LP|PARTNERS -> partnership`, `BANK|LENDING|MORTGAGE -> lender`, `else -> person`

### Module 3 -- Buyer Intelligence Engine [COMPLETE]

Buyer profiles, purchase history, lender aggregation. Pure SQL, no LLM calls.

| Component | File | Purpose |
|-----------|------|---------|
| Profiles | `src/buyers/profiles.js` | CRUD with pg_trgm fuzzy matching. Array merge on update |
| Activity | `src/buyers/activity.js` | Buyer interaction log |
| Lender Reports | `src/buyers/lender-report.js` | Lender rankings, overlap detection |
| Routes | `src/api/routes/buyers.js` | Full REST for buyers, purchases, stats, lenders |

**Buy Box Criteria:** property type, markets, cities, zip codes, price range, sqft range, lot size, units, cap rate floor, investment strategy, financing preference, close timeline, urgency.

### Module 4 -- Seller Intelligence Engine [COMPLETE]

Auto-generated seller profiles. Distress scoring. AI motivation inference.

| Component | File | Purpose |
|-----------|------|---------|
| Profiles | `src/sellers/profiles.js` | Auto-generate per foreclosure property. CRUD, search, filtering |
| Distress Score | `src/sellers/distress-score.js` | Deterministic 1-5 score with flags |
| Foreclosure Stage | `src/sellers/foreclosure-stage.js` | Date-driven: none -> pre_foreclosure -> NOD -> NTS -> auction -> REO |
| Motivation | `src/sellers/motivation.js` | LLM inference with structured JSON output |
| Portfolio Distress | `src/sellers/portfolio-distress.js` | Multi-property distress detection |

**Distress Scoring:**
```
Points (additive, clamped 1-5):
  +1.0  foreclosure flag          +0.5  equity < 20%
  +1.0  LTV > 80%                 +0.5  owner has 2+ foreclosures
  +1.0  default/assessed > 10%
  +1.0  owner-occupied
  +1.0  default age > 180 days

Bonus (base <= 1 AND foreclosure = true):
  +0.5  active trustee phone      +0.5  assessed >= $10M
  +0.5  sqft >= 50K OR units >= 50
```

**Seller Profile Auto-Generation with Graceful Fallback:**
Entity resolution chain: `owner_entity_id` -> `findOrCreateOwnerEntity(owner_name)` -> `trustee_entity_id` -> `lender_entity_id` -> skip (graceful). Properties without a resolvable entity are skipped without failing the batch.

### Module 5 -- Knowledge Base & Conversational Ingestion [COMPLETE]

Natural language ingestion, classification, knowledge graph, semantic search.

| Component | File | Purpose |
|-----------|------|---------|
| Classifier | `src/ingestion/classifier.js` | LLM-powered message classification with regex fallback. 8 categories |
| Router | `src/ingestion/router.js` | Routes classified data: create entities, buyer/seller profiles, knowledge entries, embeddings |
| Entity Merge | `src/ingestion/merge.js` | Find-or-create with fuzzy dedup (similarity >= 0.7 threshold) |
| Knowledge Extract | `src/knowledge/extract.js` | CRUD for knowledge entries. Join tables: `knowledge_entities`, `knowledge_properties` |
| Embeddings | `src/knowledge/embeddings.js` | ChromaDB storage. Provider `embed()` with deterministic fallback |
| Search | `src/knowledge/search.js` | Hybrid search: semantic (ChromaDB) + keyword (pg_trgm + ILIKE). Merge + dedupe |
| Transcription | `src/knowledge/transcribe.js` | OpenAI Whisper / Deepgram. Audio -> text -> classify -> route |

**Classification Categories:** buyer_intel, seller_intel, property_note, relationship, market_insight, deal_update, action_item, general_note

**Ingestion Flow:**
```
Message -> buildEntityContext() -> LLM classify (fallback: regex)
  -> validateClassification()
  -> create/merge entities
  -> create/update buyer_profile or seller_profile
  -> create knowledge_entry
  -> store ChromaDB embedding
  -> auto-promote to wiki (high-signal entries)
  -> run matching (if buyer_intel)
```

**Semantic Search:** Hybrid approach -- ChromaDB vector similarity in parallel with PostgreSQL pg_trgm keyword matching. Results merged by knowledge_entry ID, keeping max score from either method. Falls back to keyword-only when ChromaDB is unavailable. The `embed()` provider has a deterministic local fallback (character-based 32-dim vector) when the LLM provider is unavailable.

### Module 6 -- Matching Engine [COMPLETE]

Weighted scoring algorithm. AI narrative generation for top matches.

| Component | File | Purpose |
|-----------|------|---------|
| Scorer | `src/matching/scorer.js` | Weighted scoring across 7 dimensions. Knowledge alignment via semantic search |
| Runner | `src/matching/runner.js` | Orchestrator: fetch buyers/sellers, score pairs, persist, generate narratives |
| Explainer | `src/matching/explainer.js` | Human-readable reasons for each match score |
| Narrative | `src/matching/narrative.js` | LLM-generated broker narratives for matches >= 75 |

### Property Intelligence [COMPLETE]

Property documents, grouping, and enrichment.

| Component | File | Purpose |
|-----------|------|---------|
| Documents | `src/properties/documents.js` | Attach/store property documents (PDF, deed, title reports). Content-addressable (SHA-256) |
| Grouping | `src/properties/grouping.js` | Group related properties, normalize addresses, property group CRUD |
| Routes | `src/api/routes/properties.js` | Property detail, documents CRUD, grouping endpoints |

**Document Storage:** Files stored under `data/property-documents/<property-uuid>/<sha256-hash>.ext`. Content-addressable storage avoids duplicate files. Documents auto-create knowledge entries and can trigger wiki promotion.

### Wiki Narrative Layer [COMPLETE]

Karpathy-style narrative synthesis over PostgreSQL. Raw sources + curated wiki pages.

| Component | File | Purpose |
|-----------|------|---------|
| Promote | `src/wiki/promote.js` | Convert knowledge entries to markdown wiki pages. Slug generation, relative paths |
| Lint | `src/wiki/lint.js` | Citation checking, broken `[ke:]`/`[raw:]` validation, orphan page detection |
| Queue | `src/wiki/queue.js` | Auto-promotion workflow queue for high-signal entries |

**Wiki Structure:**
```
wiki/
  index.md                    Main index
  players/                    People, entities, operators
  lenders/                    Trustees, servicers, foreclosure ops
  submarkets/                 Market narratives
  playbooks/                  Tactical outreach & negotiation
  patterns/                   Deal archetypes, post-mortems
  properties/                 Property-specific narratives
  reports/                    Auto-generated JSON reports
```

**Citation Rules:** `[ke:<id>]` for knowledge entries, `[raw:<filename>]` for source files. Wiki must never override structured DB truth.

---

## Matching Scoring Algorithm

Weighted 0-100 score across 7 dimensions. Each buyer-seller-property triple is scored independently.

| Dimension | Max Points | Scoring Logic |
|-----------|-----------|---------------|
| Property Type | 25 | Exact match = 25, no buyer pref = 12, mismatch = 0 |
| Price | 25 | In range = 25, within 10% = 15, within 20% = 8, miss = 0 |
| Location | 20 | Target city = 20, target zip = 18, adjacent city = 10, no pref = 10 |
| Size (sqft) | 15 | In range = 15, within 20% = 10, no pref = 8, miss = 0 |
| Strategy | 15 | value_add+distress>=3 = 15, stabilized+distress<=2 = 12, flip+distress>=3 = 12, etc. |
| Timing | 10 | urgent+urgent = 10, active+urgent = 8, active+30d = 6, opportunistic+flex = 4 |
| Knowledge | +/-10 | Semantic search for buyer notes. Positive signals +3ea (cap 10), negative -5ea (cap -10) |

**Caps:** If property type = 0 and buyer has preference, cap total at 30. If price = 0 and buyer has budget, cap at 40.

**Adjacent Cities:** Hard-coded LA County adjacency map (Carson, Compton, Long Beach, Los Angeles, etc.)

**Narratives:** Generated by LLM for matches scoring >= 75. Structured JSON: match_summary, approach_strategy, deal_structures, red_flags, confidence level.

**Match Statuses:** suggested -> reviewed -> contacted -> in_negotiation -> passed/closed/archived (also: candidate, accepted, rejected)

---

## MCP Server

5 tools exposed via `@modelcontextprotocol/sdk` over stdio transport. Each tool proxies to the Express API.

| Tool | Method | API Endpoint | Purpose |
|------|--------|-------------|---------|
| `brain_add` | POST | `/api/ingest` | Natural language ingestion |
| `brain_search` | POST | `/api/search` | Hybrid semantic + keyword search |
| `brain_lookup` | GET | `/api/entities/lookup` | Entity or property detail lookup |
| `brain_match` | GET | `/api/match/:identifier` | Find matches for buyer or property |
| `brain_daily` | GET | `/api/daily` | Prioritized action list |

**Start MCP:** `node src/mcp/server.js` or `brain serve`

---

## API Endpoint Inventory

### Health (1 route)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | DB, ChromaDB, inference status. 200 or 503 |

### Ingestion (3 routes)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ingest` | Conversational ingestion. Classify + route + store |
| POST | `/api/ingest/audio` | Audio file upload -> transcribe -> ingest |
| POST | `/brain/ingest` | 501 stub |

### Search (2 routes)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/search` | Hybrid semantic + keyword search (rate-limited: 12/min) |
| GET | `/brain/search` | 501 stub |

### Entities (7 routes)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/entities` | List. `?type=&limit=&offset=` |
| GET | `/api/entities/search` | Fuzzy search. `?q=&limit=` |
| GET | `/api/entities/lookup` | Full lookup by name: entity detail, portfolio, buyer/seller profiles, knowledge |
| GET | `/api/entities/distressed` | Entities with 2+ foreclosed properties |
| GET | `/api/entities/:id` | Detail with relationships and properties |
| GET | `/api/entities/:id/portfolio` | Graph traversal: all reachable properties |
| GET | `/brain/entity/:id` | 501 stub |

### Buyers (12 routes)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/buyers` | Create profile (fuzzy-matches or creates entity) |
| GET | `/api/buyers` | List. `?property_type=&city=&strategy=&urgency=` |
| GET | `/api/buyers/search` | Fuzzy search. `?q=` |
| GET | `/api/buyers/:id` | Detail with entity and stats |
| PUT | `/api/buyers/:id` | Update. Merges arrays, appends sensibilities |
| DELETE | `/api/buyers/:id` | Soft-delete (active=false) |
| POST | `/api/buyers/:id/purchases` | Record a purchase |
| GET | `/api/buyers/:id/purchases` | Purchase history |
| GET | `/api/buyers/:id/stats` | Aggregate purchase stats |
| GET | `/api/lenders` | Lender rankings by property count |
| GET | `/api/lenders/:id` | Lender detail with properties |
| GET | `/api/lenders/overlaps` | Lenders sharing properties |

### Sellers (11 routes)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sellers` | List. `?min_distress=&motivation=&foreclosure_stage=&city=&sort_by=` |
| GET | `/api/sellers/search` | Fuzzy search. `?q=` |
| GET | `/api/sellers/:id` | Detail with property and entity |
| GET | `/api/sellers/by-property/:propertyId` | Lookup by property |
| PUT | `/api/sellers/:id` | Update profile fields |
| POST | `/api/sellers/auto-generate` | Create profiles for all foreclosure properties |
| POST | `/api/sellers/score` | Batch distress scoring. `?limit=&rescore=` |
| POST | `/api/sellers/infer` | Batch AI motivation inference. `?limit=5` |
| GET | `/api/sellers/distressed` | Portfolio-level distress |
| GET | `/api/sellers/lender-patterns` | Lender concentration patterns |
| GET | `/api/sellers/distribution` | Status/distress/stage/motivation breakdowns |

### Properties (5 routes)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/properties/:id` | Property detail + linked entities + documents |
| GET | `/api/properties/:id/group` | Property grouping/siblings |
| GET | `/api/property-groups/:id` | Property group detail |
| GET | `/api/properties/:id/documents` | List attached documents |
| POST | `/api/properties/:id/documents` | Attach document + create knowledge entry (admin, rate-limited: 10/min) |

### Knowledge (3 routes)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/knowledge` | List. `?source=&entity_id=&property_id=&classifications=` |
| GET | `/api/knowledge/:id` | Detail with linked entities and properties |
| DELETE | `/api/knowledge/:id` | Delete entry + ChromaDB embedding |

### Matching -- Run (5 routes)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/match/run` | Run full matching engine (admin, rate-limited: 6/min). `?dryRun=&generateNarratives=` |
| POST | `/api/match/run-for-buyer/:buyerId` | Score one buyer against all sellers |
| POST | `/api/match/run-for-property/:propertyId` | Score one property against all buyers |
| GET | `/api/match/distribution` | Score distribution + status breakdown |
| GET | `/api/match/:identifier` | Lookup by name/APN/address, run matching |

### Matching -- Results (7 routes)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/matches` | List. `?buyer_profile_id=&property_id=&status=&min_score=&sort_by=` |
| GET | `/api/matches/top` | Top matches. `?limit=&status=` |
| GET | `/api/matches/buyer/:buyerId` | Matches for a buyer |
| GET | `/api/matches/property/:propertyId` | Matches for a property |
| GET | `/api/matches/:id` | Match detail with buyer, seller, property, breakdown |
| PUT | `/api/matches/:id/status` | Update match status |
| POST | `/api/matches/:id/narrative` | Generate AI narrative (admin, rate-limited: 4/min, score >= 75) |

### Daily (2 routes)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/daily` | Action items from knowledge + top distressed sellers |
| GET | `/brain/daily` | 501 stub |

### Import/Export (2 routes -- stubs)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/brain/import` | 501 stub |
| GET | `/brain/export` | 501 stub |

### Legacy Stub (1 route)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/brain/match/:identifier` | 501 stub (superseded by `/api/match/:identifier`) |

**Total: 61 routes (50 implemented, 5 stubs)**

---

## Database Schema

### Tables (14)

| Table | Purpose |
|-------|---------|
| `entities` | People, LLCs, trusts, corporations, lenders. Central identity store |
| `entity_relationships` | Parent-child links with type, confidence, source |
| `properties` | Real estate assets: APN, financials, foreclosure data, metadata (JSONB) |
| `property_documents` | Attached files per property. SHA-256 content-addressable storage |
| `property_groups` | Related property grouping (multi-parcel, same-owner) |
| `buyer_profiles` | Linked to entity. Buy-box criteria, strategy, urgency |
| `buyer_purchases` | Purchase history per buyer |
| `seller_profiles` | One per property. Distress score, motivation, stage, pricing |
| `knowledge_entries` | Call transcripts, notes, emails, documents. AI summary + action items |
| `knowledge_entities` | Join table: knowledge_entries <-> entities |
| `knowledge_properties` | Join table: knowledge_entries <-> properties |
| `matches` | Buyer-seller-property triples. Score, breakdown, narrative, status |
| `deals` | Transaction lifecycle: prospect -> LOI -> under_contract -> closed |
| `_migrations` | Schema versioning |

### Migrations

| File | Purpose |
|------|---------|
| `001_core_tables.sql` | 8 tables, 10 indexes, pg_trgm extension |
| `002_realestatetool_entity_fields.sql` | Property financials: loan_amount, ltv, equity, default, beneficiary |
| `003_buyer_enhancements.sql` | Buy-box criteria, buyer_purchases table |
| `004_seller_enhancements.sql` | Distress scoring, motivation, foreclosure stage fields |
| `005_knowledge_enhancements.sql` | Knowledge AI fields, knowledge_entities + knowledge_properties join tables |
| `006_match_enhancements.sql` | Match score_breakdown, narrative, status constraints, unique buyer-property index |
| `007_property_assets.sql` | Property documents table, property groups table |
| `008_wiki_automation.sql` | Wiki promotion queue, auto-promote tracking |

### Key Relationships

```
entities 1--* entity_relationships (parent or child)
entities 1--1 buyer_profiles
entities 1--* seller_profiles
entities 1--* properties (as owner, trustee, or lender)
entities *--* knowledge_entries (via knowledge_entities)
properties 1--1 seller_profiles
properties 1--* property_documents
properties *--* knowledge_entries (via knowledge_properties)
properties 1--* matches
properties *--* property_groups
buyer_profiles 1--* buyer_purchases
buyer_profiles 1--* matches
seller_profiles 1--* matches
matches *--1 deals

UNIQUE: matches(buyer_profile_id, property_id)
UNIQUE: properties(apn, region)
UNIQUE: entities(normalized_name, entity_type)
```

### Indexes

- **Fuzzy search:** GIN trigram on `entities.normalized_name`, `properties.address`
- **Knowledge search:** GIN on `ai_classifications`, `ai_tags`
- **Match lookup:** `matches(score DESC) WHERE status='suggested'`, `matches(buyer_profile_id)`, `matches(property_id)`, `matches(status)`
- **Filtering:** Composite on `(region, foreclosure)`, `(city, state)`, `(status, score DESC)`
- **Partial:** `buyer_profiles(active) WHERE active=TRUE`, `seller_profiles(distress_level) WHERE active=TRUE`, `properties(foreclosure) WHERE foreclosure=TRUE`
- **FK lookups:** All foreign key columns indexed

---

## CLI

```bash
brain add "Mike Chen wants industrial in Carson, $4M budget, SBA"
brain add --audio recording.m4a
brain search "industrial Carson"
brain lookup "Mike Chen"
brain match "Mike Chen"          # matches for buyer
brain match "1234-567-890"       # matches for property APN
brain daily
brain serve                      # start MCP server
brain promote <ke_id>            # promote knowledge entry to wiki
brain lint                       # lint wiki for broken citations
```

---

## Scripts

| Script | Usage | Description |
|--------|-------|-------------|
| `scripts/migrate.js` | `npm run migrate` | Apply pending SQL migrations. Transactional with rollback |
| `scripts/seed-test-data.js` | `npm run seed` | Insert 10 test properties + 2 buyer profiles |
| `scripts/import-foreclosure-csv.js` | `node scripts/import-foreclosure-csv.js <csv> [--dry-run] [--limit N] [--skip-sellers]` | Full pipeline: parse UTF-16 CSV -> normalize -> dedupe -> upsert -> entities -> sellers |
| `scripts/import-from-realestatetool.js` | `node scripts/import-from-realestatetool.js --region la_county [--csv <path>]` | Import from RealEstateTool API or CSV fallback |
| `scripts/score-sellers.js` | `node scripts/score-sellers.js [--infer] [--distressed] [--report]` | Batch distress-score, motivation inference, portfolio analysis |
| `scripts/run-matching.js` | `npm run match` or `node scripts/run-matching.js [--dry-run] [--narratives] [--min-score N] [--buyer UUID] [--property UUID] [--top N] [--distribution]` | Run matching engine with various modes |
| `scripts/run-wiki-maintenance.js` | `npm run wiki:maintain` | Process auto-promote queue + lint. Output: `wiki/reports/latest-maintenance.json` |
| `scripts/transcribe-folder.js` | `node scripts/transcribe-folder.js <folder> [--once]` | Watch folder for audio files, transcribe + ingest. Moves processed files to `processed/` |
| `scripts/run-ioc-sweep.js` | `node scripts/run-ioc-sweep.js` | End-to-end smoke test: seeds data, runs 24+ integration checks, reports pass/fail |

---

## Environment Variables

```bash
# PostgreSQL
POSTGRES_HOST=localhost        # default: localhost
POSTGRES_PORT=5433             # default: 5433
POSTGRES_DB=isg_brain
POSTGRES_USER=isg
POSTGRES_PASSWORD=localdev

# ChromaDB
CHROMA_HOST=localhost
CHROMA_PORT=8000
CHROMA_URL=                    # overrides host:port
CHROMA_COLLECTION=knowledge_entries

# LLM Inference
INFERENCE_PROVIDER=claude      # claude | openai | ollama
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OLLAMA_HOST=http://localhost:11434

# Transcription
TRANSCRIPTION_PROVIDER=openai  # openai | deepgram
OPENAI_TRANSCRIPTION_MODEL=whisper-1
DEEPGRAM_API_KEY=
DEEPGRAM_URL=

# External Services
REALESTATETOOL_URL=
CA_SOS_SEARCH_URL=

# Server
API_PORT=3100
BRAIN_API_URL=                 # MCP/CLI override for API base URL
ADMIN_API_KEY=                 # Required for admin-protected endpoints
```

---

## Test Coverage

Tests use Node.js built-in test runner (`node --test`).

### Unit Tests (14)
| File | Covers |
|------|--------|
| `tests/unit/connection.test.js` | Pool singleton, query, teardown, env config |
| `tests/unit/provider.test.js` | Inference provider selection, completion |
| `tests/unit/extract.test.js` | Name normalization, entity type classification |
| `tests/unit/cluster.test.js` | Graph traversal, portfolio aggregation |
| `tests/unit/buyer-profiles.test.js` | Profile CRUD, array merge, sensibility append |
| `tests/unit/lender-report.test.js` | Lender aggregation, overlap detection |
| `tests/unit/distress-score.test.js` | Score calculation, flag detection, edge cases |
| `tests/unit/foreclosure-stage.test.js` | Stage classification by date ranges |
| `tests/unit/classifier.test.js` | Message classification, fallback extraction |
| `tests/unit/merge.test.js` | Entity fuzzy matching, find-or-create |
| `tests/unit/router.test.js` | Classified message routing |
| `tests/unit/scorer.test.js` | Match scoring dimensions, caps, edge cases |
| `tests/unit/explainer.test.js` | Human-readable match explanations |
| `tests/unit/wiki.test.js` | Wiki citation validation, lint checks |

### Integration Tests (8)
| File | Covers |
|------|--------|
| `tests/integration/db-setup.test.js` | Migration application, table creation |
| `tests/integration/entity-pipeline.test.js` | End-to-end entity extraction and linking |
| `tests/integration/buyer-pipeline.test.js` | Buyer creation, purchases, lender reports |
| `tests/integration/seller-pipeline.test.js` | Auto-generation, scoring, inference mock |
| `tests/integration/property-assets.test.js` | Property document attachment and retrieval |
| `tests/integration/ingestion-pipeline.test.js` | Full ingest flow: classify -> route -> store |
| `tests/integration/matching-pipeline.test.js` | Matching engine integration |
| `tests/integration/semantic-search.test.js` | Hybrid search with ChromaDB |

---

## File Tree

```
isg-second-brain/
  ARCHITECTURE.md
  CLAUDE.md
  README.md
  docker-compose.yml
  package.json

  briefs/
    02-entities.md
    03-buyer-intel.md
    04-seller-intel.md
    05-knowledge-base.md
    06-matching-engine.md
    07-crm-csv-test-report.md
    codex-audit-prompt.md

  raw/
    README.md

  wiki/
    index.md
    README.md
    players/
      mystery-owner-llc.md
    lenders/
    submarkets/
    playbooks/
    patterns/
    properties/
    reports/

  scripts/
    migrate.js
    seed-test-data.js
    import-from-realestatetool.js
    import-foreclosure-csv.js
    score-sellers.js
    run-matching.js
    run-wiki-maintenance.js
    run-ioc-sweep.js
    transcribe-folder.js

  src/
    api/
      server.js
      guardrails.js
      validation.js
      routes/
        health.js
        ingest.js
        search.js
        entities.js
        buyers.js
        sellers.js
        knowledge.js
        match.js
        matches.js
        properties.js
        daily.js
        import-export.js       (stub)

    cli/
      brain.js                 (CLI: add, search, lookup, match, daily, serve, promote, lint)

    db/
      connection.js
      schema.sql
      migrations/
        001_core_tables.sql
        002_realestatetool_entity_fields.sql
        003_buyer_enhancements.sql
        004_seller_enhancements.sql
        005_knowledge_enhancements.sql
        006_match_enhancements.sql
        007_property_assets.sql
        008_wiki_automation.sql

    entities/
      extract.js
      cluster.js
      resolve-llc.js

    ingestion/
      classifier.js
      router.js
      merge.js

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

    knowledge/
      extract.js
      search.js
      embeddings.js
      transcribe.js

    matching/
      scorer.js
      runner.js
      explainer.js
      narrative.js

    properties/
      documents.js
      grouping.js

    import-export/
      gateway.js
      foreclosure-import.js

    inference/
      provider.js

    mcp/
      server.js
      tools.js

    wiki/
      promote.js
      lint.js
      queue.js

    utils/
      sql.js

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
      classifier.test.js
      merge.test.js
      router.test.js
      scorer.test.js
      explainer.test.js
      wiki.test.js
    integration/
      db-setup.test.js
      entity-pipeline.test.js
      buyer-pipeline.test.js
      seller-pipeline.test.js
      property-assets.test.js
      ingestion-pipeline.test.js
      matching-pipeline.test.js
      semantic-search.test.js
```

---

## Git History

```
cf10287 merge(wiki-ops): automate promotions and document narratives
acc6f56 feat(wiki): automate promotions and property document narratives
e51eff5 merge(module-06): integrate matching and narrative layer
9e4a804 feat(wiki): add narrative layer scaffolding
0441c38 feat(property-intel): harden imports and add parcel grouping
454712e fix(api): harden ingestion and resolve IOC blockers
fc806fe docs: update architecture and add codex audit prompt
5093d7c feat: add dedicated foreclosure CSV importer with UTF-16 support
4e4f342 fix(module-05): stabilize knowledge ingestion and document csv import findings
3281383 feat(module-06): implement buyer-seller matching engine
f401048 docs: add ARCHITECTURE.md documenting modules 1-4 milestone
0cbc36b feat(module-05): implement knowledge base and conversational ingestion
3a08a5e feat(module-04): implement seller intelligence engine
7543236 test(modules-1-3): full integration verification passed 49/49
b1868cc feat(module-03): implement buyer intelligence engine
951129a feat(module-02): implement entity extraction pipeline
554c07f fix(module-01): align Docker postgres port defaults
cd5662a module 1 infrastructure scaffold
```

---

## What's Missing / Incomplete

| Gap | Status | Notes |
|-----|--------|-------|
| **Deal pipeline** | Not built | `deals` table exists but no CRUD or lifecycle management |
| **Bulk import/export API** | Stubs only | `/brain/import` and `/brain/export` return 501. CSV import is script-only |
| **ChromaDB resilience** | Fragile | Semantic search falls back to keyword when ChromaDB is down. Deterministic embedding fallback is low-quality |
| **Property enrichment** | Missing | No assessed value, sqft, lot size, or unit count in foreclosure CSV data. Matching scores suffer |
| **Owner name extraction** | Missing from CSV | Foreclosure CSV has no owner field. Seller profiles link to trustee/lender entity as fallback |
| **Price data** | Missing | No asking_price or assessed_value from CSV. Price dimension scores 0 for most matches |
| **Notification/alerts** | Not built | No daily digest push, no email, no webhook on new high-score matches |
| **Authentication** | Partial | Admin API key for protected endpoints. No user auth or RBAC |
| **Frontend** | None | API-only. No dashboard or UI |
| **Property type mapping** | Incomplete | CSV `Use` code not mapped to property_type. All CSV imports get `property_type='other'` |
| **Deduplication across sources** | Partial | Dedup by APN+region works. No cross-source entity dedup beyond pg_trgm fuzzy matching |
