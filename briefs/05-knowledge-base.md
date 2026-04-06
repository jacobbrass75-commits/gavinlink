# Module 5 — Knowledge Base & Conversational Ingestion

## Scope

Module 5 adds the conversational ingestion workflow, Chroma-backed knowledge storage and search, audio transcription, CLI access, and an MCP server so the brain can be used directly from Claude-compatible tooling.

## Deliverables

- `src/ingestion/classifier.js`
- `src/ingestion/router.js`
- `src/ingestion/merge.js`
- `src/knowledge/extract.js`
- `src/knowledge/embeddings.js`
- `src/knowledge/search.js`
- `src/knowledge/transcribe.js`
- `src/api/routes/ingest.js`
- `src/api/routes/search.js`
- `src/api/routes/knowledge.js`
- `src/mcp/server.js`
- `src/mcp/tools.js`
- `src/cli/brain.js`
- `scripts/transcribe-folder.js`
- `src/db/migrations/005_knowledge_enhancements.sql`

## Key Behaviors

- Plain-English ingestion classifies messages and routes them into entities, buyer/seller profiles, relationships, and knowledge entries.
- Every ingested message becomes a knowledge entry with AI classifications, summary, action items, and vector storage metadata.
- ChromaDB stores one embedding per knowledge entry and supports semantic plus hybrid search.
- Audio ingestion runs transcription, classification, routing, and knowledge storage in one flow.
- The CLI and MCP layers are thin wrappers over the REST API so the system is usable from terminal workflows and Claude tools.

## Acceptance Focus

- Repeated mentions of the same person merge additively via the existing Module 3 buyer logic.
- Entity creation reuses pg_trgm fuzzy matching instead of creating duplicates.
- Matching remains a graceful no-op until Module 6 exists.
- Tests mock inference, embeddings, and transcription calls so `npm test` stays deterministic and offline.
