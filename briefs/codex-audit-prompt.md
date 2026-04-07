# ISG Second Brain -- Codex Audit Prompt

You are auditing a Node.js backend for a commercial real estate intelligence platform. The system ingests property records, extracts entities, builds buyer/seller profiles, scores distress, infers seller motivation via LLMs, and matches buyers to distressed properties.

Stack: Node.js 20+ / Express 4 / PostgreSQL 16 (pg driver, no ORM) / ChromaDB / Claude API / csv-parser / xlsx / zod (declared but unused) / multer.

The codebase has 49 passing tests across 20 test files. There are 6 SQL migrations, ~40 source files, and 7 CLI scripts. Your job is to find bugs, security issues, performance problems, missing test coverage, and architectural gaps -- then produce actionable fixes ranked by severity.

---

## Codebase Map

### Database Layer

- `src/db/connection.js` -- Singleton `pg.Pool`, exports `query(text, params)` and `close()`. No pool size config, no statement timeout, no idle timeout. Pool config reads from env vars with hardcoded defaults.
- `src/db/migrations/001_core_tables.sql` -- 8 tables, pg_trgm extension, CHECK constraints, UNIQUE constraints, ~20 indexes.
- `src/db/migrations/002_realestatetool_entity_fields.sql` -- Adds financial fields to properties (loan_amount, ltv, equity, defaults).
- `src/db/migrations/003_buyer_enhancements.sql` -- Adds buy-box criteria, buyer_purchases table.
- `src/db/migrations/004_seller_enhancements.sql` -- Adds distress scoring fields, motivation, foreclosure_stage to seller_profiles.
- `src/db/migrations/005_knowledge_enhancements.sql` -- Adds chroma_id, ai_summary, ai_action_items, ai_tags, ai_classifications. Creates knowledge_entities and knowledge_properties junction tables.
- `src/db/migrations/006_match_enhancements.sql` -- Adds score_breakdown, narrative, narrative_generated_at, last_scored_at to matches. Drops and recreates status CHECK constraint. Creates partial index on suggested matches. Creates unique index on (buyer_profile_id, property_id).

### API Layer

- `src/api/server.js` -- Express app factory. `express.json()` body parsing. No request size limit configured. No global error handler middleware. No CORS. No rate limiting. No request logging.
- `src/api/routes/health.js` -- DB ping, table count, ChromaDB port probe, inference provider status.
- `src/api/routes/entities.js` -- CRUD for entities. Inline SQL queries (not extracted to a module). `getEntityDetail()` makes 3 sequential queries per request. `/api/entities/search` does NOT wrap in try/catch. `/api/entities/lookup` uses `SELECT *` and builds `$2` as `%${name}%` -- potential LIKE injection if name contains `%` or `_`. Uses `WHERE id IN ($1, $2, $3)` with nullable entity IDs.
- `src/api/routes/buyers.js` -- Full REST. UUID validation on all param routes. Delegates to `src/buyers/profiles.js` and `src/buyers/activity.js`. `POST /api/buyers` does no body validation beyond passing to `createBuyerProfile`.
- `src/api/routes/sellers.js` -- GET/PUT/POST. `POST /api/sellers/score` passes `parseLimit(req.query.limit, 0)` which means 0 = no limit, potentially scoring the entire table in one request.
- `src/api/routes/matches.js` -- CRUD for match records. `PUT /api/matches/:id/status` does not validate that req.body.status exists before passing to `updateMatchStatus`.
- `src/api/routes/match.js` -- Matching engine trigger endpoints. `POST /api/match/run` can trigger full matching across all buyers x all sellers with no auth, no rate limit, no background job queue. `GET /api/match/:identifier` runs matching live on every GET request.
- `src/api/routes/ingest.js` -- Text and audio ingestion. Audio upload via multer to os.tmpdir. `req.body.file_path` accepted as fallback -- arbitrary file path from user input.
- `src/api/routes/knowledge.js` -- CRUD for knowledge entries. DELETE endpoint.
- `src/api/routes/search.js` -- Hybrid search endpoint.
- `src/api/routes/daily.js` -- Daily digest endpoint.
- `src/api/routes/import-export.js` -- Stubbed 501 endpoints.

### Entity Pipeline

- `src/entities/extract.js` -- `normalizeName()` uppercases and trims. `classifyEntityType()` uses regex: LLC, corporation, trust, partnership, lender (only from trustee/beneficiary fields), else person. `extractEntities()` extracts owner, trustee, beneficiary from property rows. `processPropertyEntities()` wraps in a transaction with BEGIN/COMMIT/ROLLBACK.
- `src/entities/cluster.js` -- Recursive CTE graph traversal (max depth 5) with cycle protection via path array. `getPortfolio()` returns properties reachable through entity relationships. `detectPortfolioDistress()` finds entities with 2+ foreclosed properties.
- `src/entities/resolve-llc.js` -- CA Secretary of State lookup. Falls back gracefully when URL not configured.

### Ingestion Pipeline

- `src/ingestion/classifier.js` -- LLM-powered message classification. 103-line system prompt. `buildEntityContext()` does N+1 queries (one per capitalized name found in message). `fallbackClassify()` is a regex-based classifier used when the LLM fails. `validateClassification()` parses and normalizes LLM JSON output with defensive defaults.
- `src/ingestion/router.js` -- Routes classified messages to entity creation, buyer/seller profile upsert, knowledge entry creation, ChromaDB embedding. `routeClassifiedMessage()` is a ~140-line function that orchestrates everything sequentially. Creates entities one at a time in a loop. No transaction wrapping. `safeRunMatching()` uses a dynamic require to avoid circular dependency.
- `src/ingestion/merge.js` -- Entity deduplication. `findOrCreateEntity()` does exact match, then fuzzy match (threshold 0.7), then creates new. `findEntitiesFuzzy()` uses pg_trgm `similarity()`. `updateEntityDetails()` uses COALESCE to avoid overwriting existing phone/email. `createEntity()` uses ON CONFLICT with upsert. Duplicate `cleanText` and `normalizeEntityType` utility functions.

### Buyer Intelligence

- `src/buyers/profiles.js` -- CRUD with fuzzy entity matching on create. Array field merge on update. Sensibilities append with timestamps. Purchase history tracking.
- `src/buyers/activity.js` -- Log buyer interactions.
- `src/buyers/lender-report.js` -- SQL aggregation for lender rankings.

### Seller Intelligence

- `src/sellers/profiles.js` -- Auto-generate seller profiles from foreclosed properties. `createSellerProfile()` calls `getPropertyRow()`, `getSellerProfileByProperty()`, `resolveEntityId()`, `getOwnerForeclosureCount()`, `getDistressAssessment()`, `classifyForeclosureStage()` -- 6+ queries per profile creation with no transaction. `autoGenerateSellerProfiles()` loops through all foreclosed properties one at a time. `listSellerProfiles()` uses `sortClause` interpolated directly into SQL -- but from a whitelist so it is safe. `searchSellerProfiles()` builds LIKE pattern from user input.
- `src/sellers/distress-score.js` -- Deterministic 1-5 score. `batchScoreProperties()` fetches ALL properties (up to 1M limit), then loops through them one at a time doing individual upserts. `findOrCreateOwnerEntity()` is duplicated from `profiles.js`. ON CONFLICT on `property_id` but the schema has UNIQUE on `(entity_id, property_id)` not just `property_id` -- potential conflict mismatch.
- `src/sellers/foreclosure-stage.js` -- Date-driven stage classification.
- `src/sellers/motivation.js` -- LLM-powered inference. `batchInferMotivation()` processes sellers sequentially with one LLM call each.
- `src/sellers/portfolio-distress.js` -- SQL queries for portfolio-level distress patterns.

### Matching Engine

- `src/matching/scorer.js` -- Scoring algorithm. Max possible score: 25 (type) + 25 (price) + 20 (location) + 15 (size) + 15 (strategy) + 10 (timing) + 10 (knowledge) = 120, but clamped to 0-100. `ADJACENT_CITIES` is hardcoded to 4 LA-area cities. `scoreKnowledgeAlignment()` calls `semanticSearch` which can fail silently. `extractKnowledgeSignals()` does regex matching on knowledge entry content -- both positive and negative patterns checked independently so a single entry can trigger both.
- `src/matching/runner.js` -- Orchestrates matching. `evaluateMatches()` is O(buyers * sellers) with one `calculateMatchScore()` call (potentially async with DB/Chroma calls) per pair. `persistMatch()` uses ON CONFLICT on `(buyer_profile_id, property_id)` but the original schema has UNIQUE on `(buyer_profile_id, seller_profile_id, property_id)` -- migration 006 adds a separate unique index on `(buyer_profile_id, property_id)`. `lookupIdentifier()` passes raw user input into LIKE patterns and similarity functions. `MATCH_ROW_SELECT` is a SQL fragment concatenated into queries. Multiple `toNumber` / `cleanText` / `cleanStringArray` utility functions duplicated.
- `src/matching/explainer.js` -- Generates human-readable match explanations from breakdown scores.
- `src/matching/narrative.js` -- LLM-powered narrative generation. `generateMatchNarrative()` concatenates system prompt with JSON payload in a single user message (not using system/user split). `batchGenerateNarratives()` processes matches sequentially. `parseNarrativeResponse()` calls `defaultNarrative(match)` multiple times per field.

### Knowledge Base

- `src/knowledge/extract.js` -- CRUD for knowledge_entries. `createKnowledgeEntry()` inserts then links entities and properties in separate queries with no transaction. `listKnowledgeEntries()` calls `getKnowledgeEntry()` (which does 3 queries) for each row in the result -- N+1 pattern.
- `src/knowledge/search.js` -- Hybrid search combining ChromaDB semantic search with pg_trgm keyword search. `semanticSearch()` falls back to `keywordSearch()` on any Chroma error. `keywordSearch()` uses ILIKE with user input.
- `src/knowledge/embeddings.js` -- ChromaDB integration. `deterministicEmbedding()` is a fallback hash-based "embedding" when the real provider fails. Module-level `chromaClientPromise` and `collectionPromise` are cached but never invalidated on connection failure.
- `src/knowledge/transcribe.js` -- OpenAI Whisper and Deepgram transcription. Reads entire audio file into memory.

### Import Pipeline

- `src/import-export/gateway.js` -- Parses CSV, XLSX, JSON files. `parseCsv()` reads entire file into memory with `fs.readFileSync()` before piping to csv-parser. `detectEncoding()` checks BOM and null-byte patterns for UTF-16. `parseXlsx()` reads synchronously. `exportToFile()` writes CSV without BOM. No file size limit. No row count limit.
- `scripts/import-foreclosure-csv.js` -- CLI importer. Uses `parseFile()` then maps, dedupes, and batch-upserts. `upsertProperties()` wraps in transaction. `processPropertyEntities()` wraps in transaction. But seller profile auto-generation is NOT transactional.
- `scripts/import-from-realestatetool.js` -- HTTP import from external API.

### Inference Provider

- `src/inference/provider.js` -- Pluggable LLM. Only Claude is implemented. OpenAI and Ollama `complete()` throws "not implemented". `embed()` always throws. `getAnthropicClient()` caches client singleton. No retry logic. No timeout configuration.

### Tests

- `tests/unit/scorer.test.js` -- Matching scorer tests.
- `tests/unit/explainer.test.js` -- Match explainer tests.
- `tests/unit/classifier.test.js` -- Ingestion classifier tests.
- `tests/unit/router.test.js` -- Ingestion router tests.
- `tests/unit/merge.test.js` -- Entity merge/dedup tests.
- `tests/unit/connection.test.js` -- DB connection tests.
- `tests/unit/provider.test.js` -- Inference provider tests.
- `tests/unit/extract.test.js` -- Entity extraction tests.
- `tests/unit/cluster.test.js` -- Entity clustering tests.
- `tests/unit/buyer-profiles.test.js` -- Buyer profile tests.
- `tests/unit/lender-report.test.js` -- Lender report tests.
- `tests/unit/distress-score.test.js` -- Distress scoring tests.
- `tests/unit/foreclosure-stage.test.js` -- Foreclosure stage tests.
- `tests/integration/db-setup.test.js` -- Migration tests.
- `tests/integration/entity-pipeline.test.js` -- End-to-end entity tests.
- `tests/integration/buyer-pipeline.test.js` -- Buyer pipeline tests.
- `tests/integration/seller-pipeline.test.js` -- Seller pipeline tests.
- `tests/integration/ingestion-pipeline.test.js` -- Ingestion pipeline tests.
- `tests/integration/matching-pipeline.test.js` -- Matching pipeline tests.
- `tests/integration/semantic-search.test.js` -- Search tests.

---

## Audit Tasks

Work through each section below. For every issue found, report:
- **File and line number**
- **Severity**: critical / high / medium / low
- **Category**: security / bug / performance / test-gap / architecture / data-integrity
- **Description**: What is wrong and why it matters.
- **Fix**: Concrete code change or approach. Include the actual code when the fix is small enough.

### 1. Security Audit

Examine every file that handles user input and produces SQL queries or file system operations.

**SQL Injection surface:**
- `src/api/routes/entities.js` lines 215-229: The `/api/entities/lookup` endpoint builds `%${name}%` for ILIKE. The `name` variable comes directly from `req.query.name`. If the user sends `name=%` or `name=_`, the LIKE wildcards are not escaped. Check every instance of ILIKE or LIKE across the codebase where user input is interpolated into the pattern.
- `src/matching/runner.js` lines 706-746: `lookupIdentifier()` builds `%${identifier}%` from raw input.
- `src/knowledge/search.js` lines 82-126: `keywordSearch()` builds `%${q}%` from user search query.
- `src/sellers/profiles.js` lines 537-572: `searchSellerProfiles()` builds `%${q}%`.
- `src/ingestion/router.js` lines 56-69: `findPropertyByReference()` builds `%${address}%`.

For each of these, determine whether the LIKE special characters `%` and `_` in user input could cause unexpected query behavior (returning all rows, performance degradation from unanchored wildcards). Propose a `escapeLikePattern()` utility.

**File path injection:**
- `src/api/routes/ingest.js` line 41: `req.body.file_path` is passed directly to `processAudioFile()` which calls `fs.promises.readFile()`. An attacker can read arbitrary files from disk. This is a critical vulnerability.

**Missing input validation:**
- `POST /api/buyers` accepts any JSON body with no schema validation. zod is in package.json but never imported anywhere in the codebase.
- `PUT /api/sellers/:id` accepts any JSON body.
- `PUT /api/matches/:id/status` -- the route handler does not check that `req.body.status` is defined before calling `updateMatchStatus`, which will throw with a generic error.
- `POST /api/match/run` -- no auth, no rate limiting, triggers potentially expensive O(n*m) computation.
- `POST /api/sellers/infer` -- triggers LLM API calls with cost implications, no auth.

**Missing security middleware:**
- No CORS configuration.
- No helmet or security headers.
- No rate limiting.
- No authentication/authorization on any endpoint.
- No request body size limit (express.json() defaults to 100kb but this is not explicitly set).
- multer has no file size limit configured.

### 2. Bug Hunt

**Unique constraint mismatch in matches table:**
- `001_core_tables.sql` line 174 defines UNIQUE on `(buyer_profile_id, seller_profile_id, property_id)`.
- `006_match_enhancements.sql` line 62 creates a unique index on `(buyer_profile_id, property_id)`.
- `src/matching/runner.js` line 246 uses `ON CONFLICT (buyer_profile_id, property_id)` in `persistMatch()`.
- This means two different sellers for the same property can't both have matches with the same buyer. The triple-unique from migration 001 is now effectively dead. Determine whether this was intentional or a bug.

**ON CONFLICT mismatch in distress-score.js:**
- `src/sellers/distress-score.js` line 396 uses `ON CONFLICT (property_id)` but the seller_profiles table has UNIQUE on `(entity_id, property_id)`, not just `property_id`. Migration 004 may or may not add a separate unique index on just `property_id`. Verify. If not, this ON CONFLICT will fail at runtime.

**Entity search missing error handling:**
- `src/api/routes/entities.js` line 279: The `/api/entities/search` handler does NOT have try/catch. If the query fails, Express will get an unhandled promise rejection since the function is async but errors are not caught. Compare with line 39 of buyers.js which correctly uses try/catch/next.

**Unvalidated sort_by in runner.js:**
- `src/matching/runner.js` lines 511-516: `sortClause` is built from `filters.sort_by`. The code handles 3 known values and has a default, but `sortClause` is interpolated directly into SQL. Verify that the default branch is always safe.

**Health check false negative:**
- `src/api/routes/health.js` line 84: `ok = databaseStatus.connected && chromaConnected`. If ChromaDB is intentionally not running (it's described as "reserved, not yet populated"), the health check returns 503. This makes the health endpoint unusable for DB-only deployments.

**`getProvider()` returns provider name, not provider object:**
- `src/api/routes/health.js` line 77: `providerName = getProvider()` -- `getProvider()` returns a string like "claude", which is correct for display. But the catch block also assigns a string. This is fine but confusing naming.

**`seller_profiles` UNIQUE constraint:**
- The original schema has `UNIQUE (entity_id, property_id)`. But `autoGenerateSellerProfiles()` creates one profile per property, and multiple properties can share the same owner entity. Verify that the schema allows this or if it breaks when the same entity owns 2+ foreclosed properties.

### 3. Performance Audit

**N+1 query patterns:**
- `src/knowledge/extract.js` line 298: `listKnowledgeEntries()` calls `getKnowledgeEntry(row.id)` for each row. `getKnowledgeEntry()` itself runs 3 queries (the entry, linked entities, linked properties). For a page of 50 results, that's 150 queries.
- `src/ingestion/classifier.js` line 567: `buildEntityContext()` runs 1-3 queries per capitalized name found in the message.
- `src/sellers/profiles.js` line 574: `autoGenerateSellerProfiles()` runs `createSellerProfile()` per property, which itself runs 6+ queries.
- `src/sellers/distress-score.js` line 321: `batchScoreProperties()` runs one upsert per property.
- `src/matching/runner.js` line 335: `evaluateMatches()` is O(buyers * sellers), each iteration calling `calculateMatchScore()` which may call `semanticSearch()`.

**Missing database connection pool configuration:**
- `src/db/connection.js`: No `max`, `idleTimeoutMillis`, `connectionTimeoutMillis`, or `statement_timeout` configured on the pool. The pg default max is 10 connections, which is fine for dev but will cause connection starvation under load. The lack of `statement_timeout` means a runaway query can hold a connection indefinitely.

**Full table scans:**
- `batchScoreProperties()` fetches up to 1,000,000 rows with `LIMIT $1` where the default limit is 1M.
- `autoGenerateSellerProfiles()` fetches ALL foreclosed properties with no pagination.

**Synchronous file I/O:**
- `src/import-export/gateway.js` line 47: `fs.readFileSync()` in `parseCsv()` blocks the event loop for the entire file read.
- `src/import-export/gateway.js` line 96: `XLSX.readFile()` in `parseXlsx()` is synchronous.

**Missing indexes:**
- `seller_profiles.property_id` has an index but there may not be a standalone unique index on it (verify against migration 004). The `ON CONFLICT (property_id)` in distress-score.js requires one.
- `matches.buyer_profile_id` -- migration 006 adds this. Verify it exists.
- `knowledge_entries` has no full-text search index. All text search relies on pg_trgm similarity and ILIKE, which require sequential scans on the content column.

### 4. Schema Review

Check all 6 migrations for:

- **Missing indexes**: Any foreign key column without an index. Any column frequently used in WHERE/ORDER BY without an index.
- **Constraint gaps**: `properties.property_type` allows any non-empty text but the application expects specific values (industrial, multifamily, retail, office, commercial, other). Should this be a CHECK constraint?
- **Data type issues**: All monetary values use `NUMERIC(14,2)` which maxes at $999,999,999,999.99 -- adequate. But `score NUMERIC(5,2)` in matches allows up to 999.99 while the application clamps to 0-100. The CHECK constraint enforces 0-100, so this is fine but wasteful.
- **seller_profiles UNIQUE constraint**: `UNIQUE (entity_id, property_id)` prevents the same entity from having two profiles for the same property. But `autoGenerateSellerProfiles()` assigns one profile per property, not per entity. If entity A owns properties X and Y, both get profiles. This is fine because the unique constraint is on the pair. But verify that the ON CONFLICT clauses align.
- **matches constraint evolution**: Migration 001 has `UNIQUE (buyer_profile_id, seller_profile_id, property_id)`. Migration 006 adds `UNIQUE INDEX (buyer_profile_id, property_id)`. The application uses `ON CONFLICT (buyer_profile_id, property_id)`. Does this mean the triple-unique constraint is now redundant? Should it be dropped?
- **Missing updated_at triggers**: No tables have automatic `updated_at` triggers. The application manually sets `updated_at = NOW()` in every UPDATE query. If any UPDATE misses this, the timestamp goes stale.

### 5. Test Coverage Gaps

**Untested modules:**
- `src/import-export/gateway.js` -- No tests for CSV parsing, XLSX parsing, JSON parsing, encoding detection, or file export. This is a parsing module that handles external data -- high risk for bugs.
- `src/knowledge/transcribe.js` -- No tests for audio transcription flow.
- `src/knowledge/embeddings.js` -- No tests for ChromaDB storage, deterministic embedding fallback, or vector normalization.
- `src/knowledge/search.js` -- `tests/integration/semantic-search.test.js` exists but verify it covers keyword search, semantic search, hybrid merge, and metadata filtering.
- `src/matching/narrative.js` -- No unit tests for narrative generation, JSON parsing, or fallback behavior.
- `src/sellers/motivation.js` -- No unit tests for `inferMotivation()`, `parseProviderJson()`, or `normalizeInferenceResult()`.
- `src/sellers/portfolio-distress.js` -- No unit tests.
- `src/api/server.js` -- No tests for the Express app factory or route registration.
- All API route handlers -- No HTTP-level integration tests.

**Missing edge case tests for scorer.js:**
- What happens when buyer has null/undefined for all criteria? (Should return baseline scores for each dimension.)
- What happens when property has null for all values? (All dimension scores should be 0 or baseline.)
- Both buyer and property completely empty -- verify it returns 0 not NaN.
- `scorePrice()` when minPrice equals maxPrice (exact match scenario).
- `scoreLocation()` with a city in ADJACENT_CITIES map vs. one not in the map.
- `scoreStrategy()` with every strategy value including unknown strings.
- `scoreTiming()` with every combination of urgency x timeline.
- `scoreKnowledgeAlignment()` when semanticSearch returns results that match both positive and negative patterns.
- Score capping: verify that when property_type scores 0 and buyer has property types, total is capped at 30.
- Score capping: verify that when price scores 0 and buyer has price range, total is capped at 40.

**Missing edge case tests for classifier.js:**
- Empty string message.
- Message with only whitespace.
- Message with no capitalized names.
- Message with company names but no person names.
- LLM returns invalid JSON.
- LLM returns JSON wrapped in markdown code fences.
- LLM returns JSON with extra fields.
- `fallbackClassify()` with messages containing all classification keywords simultaneously.
- `parsePriceToken()` with edge values: "0", "0K", "0M", negative numbers, very large numbers.
- `extractPropertyRef()` with addresses that don't match the pattern.
- `buildEntityContext()` when DB is unavailable.

**Missing edge case tests for gateway.js:**
- CSV with BOM (UTF-8, UTF-16LE, UTF-16BE).
- CSV with mixed line endings (CRLF, LF, CR).
- CSV with quoted fields containing commas and newlines.
- CSV with empty rows.
- CSV with inconsistent column counts.
- XLSX with multiple sheets (should use first sheet).
- XLSX with empty first sheet.
- XLSX with date-formatted cells.
- JSON file that is not an array.
- JSON file that is an array of primitives.
- File that does not exist.
- File with unsupported extension.
- Very large file (memory pressure).
- File with non-UTF-8 encoding that isn't UTF-16.

**Missing edge case tests for distress-score.js:**
- Property with all null financial fields.
- Property with equity_percent as decimal (0.15) vs. percentage (15).
- Property with negative equity.
- Property with default_date in the future.
- Property with owner_occupied=true and foreclosure=true (both flags trigger).
- Bonus scoring: base score exactly 1 with foreclosure=true and all bonus conditions met.

### 6. Architecture Review

**Duplicated utility functions:**
- `cleanText()` is defined in: classifier.js, router.js, merge.js, profiles.js (sellers), distress-score.js, motivation.js, narrative.js, search.js, extract.js (knowledge), transcribe.js. That's 10 identical copies.
- `toNumber()` is defined in: scorer.js, runner.js, distress-score.js, profiles.js (sellers). 4 copies.
- `cleanStringArray()` is defined in: classifier.js, router.js, scorer.js, runner.js, narrative.js, search.js, extract.js (knowledge). 7 copies, with slight variations.
- `isUuid()` is defined in: buyers.js, sellers.js, entities.js, matches.js, match.js, knowledge.js. 6 identical copies.
- `parseLimit()` and `parseOffset()` are defined in: buyers.js, sellers.js, matches.js, knowledge.js. 4 copies each.

Extract these into `src/utils/sanitize.js` and `src/utils/pagination.js`.

**Duplicated business logic:**
- `findOrCreateOwnerEntity()` exists in both `src/sellers/profiles.js` (line 132) and `src/sellers/distress-score.js` (line 234). Nearly identical code. Extract to a shared module.
- `normalizeOwnerEntityType()` is duplicated in the same two files.
- `computeEstimatedEquity()` is in both `src/sellers/profiles.js` and `src/sellers/distress-score.js`.
- `deriveTimeline()` in profiles.js and `getDefaultTimeline()` in distress-score.js are functionally identical.

**Circular dependency risk:**
- `src/ingestion/router.js` line 150: `safeRunMatching()` uses `require('../matching/runner.js')` inside the function body to avoid a circular dependency. This is a code smell indicating the module boundaries need rethinking. The ingestion router should emit an event or return data that a higher-level orchestrator uses to trigger matching, rather than reaching into the matching module directly.

**Missing error handling middleware:**
- `src/api/server.js` registers routes but has no global error handler. If a route handler throws and calls `next(error)`, Express will use its default error handler which sends the full stack trace in development. Add a custom error handler that returns structured JSON errors and logs appropriately.

**No transaction boundaries in ingestion:**
- `src/ingestion/router.js` `routeClassifiedMessage()` creates entities, relationships, buyer profiles, seller profiles, knowledge entries, and ChromaDB embeddings without any transaction wrapping. If the process fails midway, the database is left in an inconsistent state (entities created but knowledge entry missing, etc.).

**Zod unused:**
- `zod` is declared in package.json dependencies but never imported. Either remove it or implement request validation schemas for all API endpoints.

### 7. Matching Engine Deep Review

Review `src/matching/scorer.js` line by line:

- **Weight distribution**: property_type (25), price (25), location (20), size (15), strategy (15), timing (10) = 110 max before knowledge. With knowledge +10 that's 120. Clamped to 100. This means a perfect match on all dimensions scores 100, but it's impossible to know which 20 points were discarded. Should the weights sum to 100 instead?
- **Baseline scores**: When a buyer has no criteria set, some dimensions return a baseline (property_type: 12, price: 12, location: 10, size: 8, strategy: 5). Total baseline: 47. This means a buyer with zero preferences scores 47 against any property. Is this the intended behavior? A buyer with no criteria should arguably match everything at a moderate score.
- **Adjacent cities**: Hardcoded to 4 LA-area cities. This will need to scale. Should be configurable or stored in the database.
- **Score capping logic** (lines 359-365): If property_type scores 0 AND the buyer has property types specified, total is capped at 30. If price scores 0 AND buyer has a price range, total is capped at 40. These caps can interact: a match that fails both type and price would be capped at min(30, 40) = 30. Verify this is intentional.
- **Knowledge alignment**: The `scoreKnowledgeAlignment()` function calls `semanticSearch()` which may hit ChromaDB or fall back to keyword search. In a batch matching run with 100 buyers x 1000 sellers, that's 100,000 semantic search calls. The `skipKnowledge` option exists and is used for dry runs, but live matching will be extremely slow.
- **Missing scoring dimensions**: No consideration of cap_rate (buyer has min_cap_rate but scorer ignores it), lot_size (buyer has min/max but scorer ignores it), unit count (buyer has min/max but scorer ignores it), financing preference, close timeline. These are in the buyer profile schema but not scored.

Review `src/matching/runner.js`:

- **O(n*m) complexity**: `evaluateMatches()` iterates all buyers x all sellers. For 100 buyers and 10,000 sellers, that's 1M iterations, each with async DB calls. No parallelization, no batching, no early termination.
- **Race condition in persistMatch()**: Multiple concurrent matching runs could produce conflicting ON CONFLICT updates. The `(xmax = 0) AS inserted` check distinguishes insert from update, but concurrent writes could cause lost updates.
- **lookupIdentifier() fuzzy matching**: Uses `e.normalized_name % $1` which is a pg_trgm operator that may return unexpected results for short strings. Also uses `similarity(COALESCE(address, ''), $1) >= 0.35` which is a very low threshold.

### 8. Import Pipeline Review

Review `src/import-export/gateway.js`:

- **Memory usage**: `parseCsv()` reads the entire file synchronously into a Buffer, then potentially transcodes it. For a 500MB CSV, this will consume 1GB+ of RAM (original buffer + decoded string).
- **Stream error handling**: The CSV parser has `.on('error', reject)` attached twice (lines 72 and 92). The second one is on the csv-parser stream, the first on the file stream. But if the file stream errors after piping starts, the error may not propagate correctly.
- **UTF-16BE byte swapping**: Lines 56-59 swap bytes in-place. If the buffer length is odd, the last byte is silently dropped. Add a check.
- **XLSX null handling**: `rawRows[0].map((value) => String(value))` on line 122 -- if a header cell is null, this produces the string "null" as a column name.
- **CSV column name collision**: If two columns have the same name after trimming, the second overwrites the first.
- **No row count limit**: A file with 10M rows will consume all available memory.

Review `scripts/import-foreclosure-csv.js`:

- **No error handling per row**: If `upsertProperties()` fails on row N, the entire batch is rolled back. There's no option for partial import with error logging.
- **`processPropertyEntities()` transaction scope**: The function wraps all entity operations in a single transaction. If entity extraction fails for one property, all entities from the batch are rolled back.
- **Missing `close()` on error**: The finally block calls `close()` but the main catch block only logs the error. If the DB pool has pending queries, `close()` may hang.

---

## Output Format

Produce your findings in this structure:

```
## Critical Issues (fix immediately)
1. [SECURITY] File path injection in audio ingestion -- src/api/routes/ingest.js:41
   ...

## High Priority (fix before production)
1. [BUG] ON CONFLICT mismatch in distress-score.js -- src/sellers/distress-score.js:396
   ...

## Medium Priority (fix in next sprint)
1. [PERFORMANCE] N+1 queries in listKnowledgeEntries -- src/knowledge/extract.js:298
   ...

## Low Priority (tech debt)
1. [ARCHITECTURE] Duplicated cleanText() across 10 files
   ...

## Test Cases to Add
1. gateway.js: UTF-16LE CSV with BOM
   ...

## Recommended Architectural Changes
1. Extract shared utilities into src/utils/
   ...
```

For each fix, provide the actual code change when it is under 30 lines. For larger changes, describe the approach and list the files that need modification.

Prioritize issues that could cause data corruption, security vulnerabilities, or runtime crashes in production. Performance issues in batch operations are high priority because this system will process thousands of properties.
