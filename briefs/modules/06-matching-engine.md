## Module 6: Buyer-Seller Matching Engine

This module scores active buyer profiles against active seller properties, stores high-signal matches, and exposes them through the API, CLI, and Module 5 ingestion hook.

Core pieces:
- Weighted scoring across property type, price, location, size, strategy, timing, and knowledge alignment
- Match persistence with idempotent upserts
- Optional AI narratives for high-scoring matches
- Batch runner for nightly matching and real-time matching hooks
- REST endpoints for listing, inspecting, updating, and triggering matches

The implementation is built against the actual repo schema:
- `matches.score` remains the canonical numeric score column
- `matches.factor_scores` is preserved for backwards compatibility
- `matches.score_breakdown`, `matches.narrative`, and timing metadata are added in migration 006
- Match uniqueness is enforced per `(buyer_profile_id, property_id)`
