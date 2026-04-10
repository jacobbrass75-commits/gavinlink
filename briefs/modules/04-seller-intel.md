# Module 4 — Seller Intelligence Engine

## Scope

Module 4 adds seller profile management, distress scoring, foreclosure stage classification, AI-assisted seller motivation inference, and portfolio-level distress reporting. It builds on Modules 1-3 and uses the existing inference provider for the first time.

## Deliverables

- `src/sellers/profiles.js`
- `src/sellers/distress-score.js`
- `src/sellers/foreclosure-stage.js`
- `src/sellers/motivation.js`
- `src/sellers/portfolio-distress.js`
- `src/api/routes/sellers.js`
- `src/db/migrations/004_seller_enhancements.sql`
- `scripts/ops/score-sellers.js`
- `tests/unit/distress-score.test.js`
- `tests/unit/foreclosure-stage.test.js`
- `tests/integration/seller-pipeline.test.js`

## Key Behaviors

- Auto-generate one seller profile per foreclosed property using `properties.owner_entity_id`.
- Distress score is a 1-5 weighted score driven by foreclosure, leverage, default size, owner occupancy, process age, low equity, and portfolio distress.
- Foreclosure stage is classified from foreclosure state, dates, and TitlePro metadata.
- Motivation inference calls the shared inference provider and must gracefully fall back to an `unknown` response if the provider fails or returns malformed JSON.
- Portfolio distress and lender-owner patterns are SQL-first reports over the existing `properties` and `seller_profiles` data.

## API

- `GET /api/sellers`
- `GET /api/sellers/search?q=`
- `GET /api/sellers/:id`
- `GET /api/sellers/by-property/:propertyId`
- `PUT /api/sellers/:id`
- `POST /api/sellers/auto-generate`
- `POST /api/sellers/score`
- `POST /api/sellers/infer`
- `GET /api/sellers/distressed`
- `GET /api/sellers/lender-patterns`
- `GET /api/sellers/distribution`

## Acceptance Focus

- Seller profiles are auto-generated and idempotent.
- Distress scoring and foreclosure stage classification pass unit coverage.
- Inference is mocked in tests, not live.
- Distribution output is meaningful on the 10-property fixture instead of collapsing to a single bucket.
- Modules 1-3 stay green while Module 4 tests pass.
