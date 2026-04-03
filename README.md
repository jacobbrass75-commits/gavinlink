# ISG Second Brain

Module 1 provides the local infrastructure for the ISG Second Brain: PostgreSQL 16, ChromaDB, the initial schema, migrations, seed data, an Express API scaffold, an inference-provider scaffold, and import/export parsing utilities.

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
  "chromadb": "connected",
  "inference_provider": "claude",
  "version": "0.1.0"
}
```

If PostgreSQL or ChromaDB is unavailable, the route responds with HTTP 503 and the same JSON shape with the failing dependency marked `disconnected`.
