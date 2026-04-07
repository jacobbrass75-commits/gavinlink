# ISG Second Brain

ISG Second Brain is a local-first commercial real estate intelligence backend. It now includes:

- PostgreSQL + ChromaDB infrastructure
- entity, buyer, seller, knowledge, and matching workflows
- foreclosure CSV import with dry-run preview and parcel grouping
- property document attachment support
- a narrative `raw/` + `wiki/` layer governed by `CLAUDE.md`

## Prerequisites

- Node.js 20+
- npm
- Docker Desktop or a compatible Docker runtime

## Setup

1. Copy `.env.example` to `.env` and adjust values if needed. By default, PostgreSQL is mapped to `5433` to avoid colliding with a locally installed Postgres on macOS.
2. Start the local services:

```powershell
docker-compose up -d
```

3. Install dependencies:

```powershell
npm install
```

4. Run database migrations:

```powershell
node scripts/migrate.js
```

5. Seed the 10 provided test properties:

```powershell
node scripts/seed-test-data.js
```

6. Start the API server:

```powershell
npm start
```

7. Run the test suite:

```powershell
npm test
```

## Endpoints

- `GET /health`
- `POST /api/import/foreclosure/preview`
- `POST /api/import/foreclosure`
- `GET /api/properties/:id`
- `GET /api/properties/:id/group`
- `POST /api/properties/:id/documents`
- `POST /brain/ingest`
- `GET /brain/search`
- `GET /brain/entity/:id`
- `GET /brain/match/:identifier`
- `GET /brain/daily`
- `POST /brain/import`
- `GET /brain/export`

## Health Response

When all dependencies are reachable, `GET /health` returns:

```json
{
  "status": "ok",
  "database": "connected",
  "tables": 8,
  "tables_total": 15,
  "core_tables_expected": 8,
  "chromadb": "connected",
  "inference_provider": "claude",
  "version": "0.1.0"
}
```

If PostgreSQL or ChromaDB is unavailable, the route responds with HTTP 503 and the same JSON shape with the failing dependency marked `disconnected`.

## Foreclosure Import

Preview a real foreclosure CSV without writing data:

```bash
node scripts/import-foreclosure-csv.js /path/to/foreclosures.csv --dry-run
```

Run the live import:

```bash
node scripts/import-foreclosure-csv.js /path/to/foreclosures.csv
```

The importer is UTF-16 aware, deduplicates by `(apn, region)`, records every raw row in `property_import_records`, and groups likely multi-row parcels in `property_groups`.

## Narrative Wiki

The repo includes a Karpathy-inspired narrative layer:

- `raw/` for immutable source material
- `wiki/` for curated markdown pages
- `CLAUDE.md` for citation and maintenance rules

Promote a knowledge entry into the wiki:

```bash
brain promote <knowledge_entry_id>
```

Lint the wiki for missing citations and stale references:

```bash
brain lint
```
