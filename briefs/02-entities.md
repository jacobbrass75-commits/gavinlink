# Module 2 — Entity Extraction & LLC Resolution

## Scope

Module 2 imports foreclosure properties from `realestatetool`, extracts owner and trustee entities into PostgreSQL, supports optional California Secretary of State lookups for LLC resolution, and exposes entity and portfolio APIs for traversal across people, LLCs, and properties.

## Implementation Notes

- The import pipeline prefers live `REALESTATETOOL_URL` access and falls back to `--csv` file imports parsed through Module 1's `gateway.js`.
- The implementation matches the actual Module 1 schema, so Module 2 adds new property columns through `002_realestatetool_entity_fields.sql` instead of rewriting the original migration.
- The legacy `GET /brain/entity/:id` Module 1 stub remains in place for backward compatibility and test stability.
- The working Module 2 API lives under:
  - `GET /api/entities`
  - `GET /api/entities/:id`
  - `GET /api/entities/:id/portfolio`
  - `GET /api/entities/search?q=...`
  - `GET /api/entities/distressed`

## Files

- `src/integrations/realestatetool.js`
- `src/entities/extract.js`
- `src/entities/resolve-llc.js`
- `src/entities/cluster.js`
- `scripts/import-from-realestatetool.js`
- `tests/unit/extract.test.js`
- `tests/unit/cluster.test.js`
- `tests/integration/entity-pipeline.test.js`

## Acceptance Targets

- Idempotent property imports via live HTTP or file fallback.
- Entity extraction from owner, trustee, and beneficiary fields.
- Deduplicated entities via `(normalized_name, entity_type)`.
- Property foreign-key links to owner, trustee, and lender/beneficiary entities.
- Portfolio traversal with cycle protection.
- Distress detection for portfolios with multiple foreclosures.
- All tests green under `npm test`.
