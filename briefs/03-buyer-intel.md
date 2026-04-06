# Module 3 — Buyer Intelligence Engine

## Scope

Module 3 adds buyer-profile CRUD, lender aggregation, and buyer activity tracking on top of the Module 1 and Module 2 database. It is pure PostgreSQL and API work: no Claude calls, no realestatetool dependency, and no Chroma usage.

## Key Behavior

- Buyer creation links to an existing entity via pg_trgm fuzzy matching when similarity is strong enough; otherwise it creates a new buyer entity.
- Buyer profile updates merge array fields instead of replacing them.
- `sensibilities` appends new notes with a `[YYYY-MM-DD]` timestamp during updates.
- Lender reporting is SQL-only over `properties.trustee_entity_id` and `properties.lender_entity_id`.
- Purchase history is stored separately in `buyer_purchases`.

## Files

- `src/db/migrations/003_buyer_enhancements.sql`
- `src/buyers/profiles.js`
- `src/buyers/lender-report.js`
- `src/buyers/activity.js`
- `src/api/routes/buyers.js`
- `tests/unit/buyer-profiles.test.js`
- `tests/unit/lender-report.test.js`
- `tests/integration/buyer-pipeline.test.js`

## API

- `POST /api/buyers`
- `GET /api/buyers`
- `GET /api/buyers/search?q=...`
- `GET /api/buyers/:id`
- `PUT /api/buyers/:id`
- `DELETE /api/buyers/:id`
- `POST /api/buyers/:id/purchases`
- `GET /api/buyers/:id/purchases`
- `GET /api/buyers/:id/stats`
- `GET /api/lenders`
- `GET /api/lenders/:id`
- `GET /api/lenders/overlaps`
