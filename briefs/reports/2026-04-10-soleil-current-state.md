# Soleil / Sullivan Link Brain - Current State And Next Steps

Date: 2026-04-10

## Executive Summary

The repo is materially further along than the older "Module 1 complete, Module 2 next" plan suggests.
In the current working tree, the core brain already exists across all six planned module areas:

- database and migrations
- property/entity import and LLC resolution
- buyer intelligence
- seller intelligence
- knowledge ingestion and semantic search
- buyer-seller-property matching

What is still missing is the adapter layer around that core:

- Telegram interaction
- Hermes/Vermes agent bridge
- Obsidian sync
- Omi recorder ingestion
- outbound alerts and broker automation

The immediate conclusion is that the next phase should not be framed as "build the brain from scratch."
The next phase should be framed as "stabilize the brain, then connect channels and automations around it."

## What Exists Right Now

### Core brain

- PostgreSQL schema plus follow-on migrations exist for buyers, sellers, knowledge links, matching, property assets, wiki automation, and property alert events.
- Chroma-backed semantic recall exists with keyword fallback.
- Entity extraction, relationship linking, portfolio clustering, and LLC resolution exist.
- Buyer profiles, lender reporting, purchase history, and buyer search exist.
- Seller profile generation, distress scoring, foreclosure stage classification, motivation inference, and lender-owner pattern reports exist.
- Conversational ingestion exists for text and audio.
- Matching exists with scoring, explanations, persistence, and narrative generation.

### Runtime surfaces

- `/api/*` is the real HTTP interface.
- `brain` CLI exists and is usable today.
- MCP exists as a local stdio server that proxies into the API.
- Property documents can be attached, mirrored into `raw/`, turned into knowledge entries, and pushed into the wiki queue.

### Current ingestion and enrichment doors

- foreclosure file import
- `realestatetool` property import
- voice/audio transcription
- manual conversational ingestion
- property document ingestion
- California LLC resolution
- local Gmail + PropertyRadar alert ingestion in the current working tree

## What Does Not Exist Yet

There is no code evidence yet for:

- Telegram bot or webhook transport
- Hermes/Vermes runtime or bridge layer
- Obsidian client or sync worker
- Omi recorder integration
- outbound alerting layer for email, Slack, or Telegram
- remote MCP/SSE broker-facing gateway
- dedicated broker web app in this repo

That means Soleil already has a brain, but it does not yet have the full nervous system you described.

## The Real Architecture Going Forward

The clean mental model should be:

### 1. Soleil core

This repo's durable center:

- PostgreSQL
- ChromaDB
- domain logic in `src/entities`, `src/buyers`, `src/sellers`, `src/knowledge`, `src/matching`

This remains the source of truth.

### 2. Intake adapters

Systems that feed Soleil:

- `realestatetool`
- foreclosure CSV/XLSX imports
- PropertyRadar via Gmail
- voice memos
- Omi recorder
- title and lender document sources

These should normalize incoming information into a single ingestion/event contract before touching domain tables.

### 3. Interaction adapters

How brokers and agents talk to Soleil:

- HTTP API
- local MCP
- CLI
- Telegram
- Hermes/Vermes
- future dashboard

These should be thin transport layers over shared application services, not each reinventing orchestration.

### 4. Automation and delivery adapters

What Soleil does after it knows something:

- matching runs
- seller rescoring
- narrative/wiki promotion
- daily brief generation
- outbound alerts
- Obsidian note publishing

This should become a worker/job layer, not a pile of unrelated scripts.

## Main Gaps Blocking Scale

### Security and deployment posture

- write protection depends on `ADMIN_API_KEY` being set; if unset, privileged routes are effectively open
- the main ingest write path is not admin-guarded
- this is acceptable for local development, but not for a deployed team-facing runtime

### Application boundary

- route files, scripts, CLI, and MCP all reach into domain/database logic directly
- `src/ingestion/router.js` currently coordinates too many cross-domain side effects
- the repo needs an explicit application layer such as `src/app/` or `src/services/`

### Schema authority drift

- `src/db/schema.sql` still looks like the old base system
- the real contract now lives in migrations
- that is dangerous for onboarding and tooling when multiple people are committing

### Testing and contributor workflow

- tests are meaningful, but they are not easy for a new contributor to run
- several "unit" tests really depend on live Postgres/Chroma
- there is no clear CI quality gate or coverage threshold

### Channel and automation backlog

- Telegram, Omi, Obsidian, Hermes/Vermes, Monday, and outbound notifications are not built yet
- this is the biggest product gap relative to the end-state vision

## Recommended Build Order

### Phase 1: Hardening the core

Do this before adding more channels.

1. Make auth and admin boundaries explicit.
2. Create an application-service layer and move orchestration there.
3. Make `/api/*` the canonical API and either implement or remove stale `/brain/*` HTTP stubs.
4. Make health checks reflect the real product surface, not just the original 8 tables.
5. Define one authoritative schema story: migrations first, generated schema second.
6. Split tests into fast local tests and full integration tests.

### Phase 2: Build the adapter spine

1. Define a shared event contract for inbound facts:
   - source
   - actor
   - property refs
   - entity refs
   - content
   - attachments
   - timestamps
   - downstream triggers
2. Add a jobs/worker layer for:
   - matching
   - wiki promotion
   - notifications
   - channel sync
3. Standardize adapter ownership:
   - intake adapters write normalized events
   - interaction adapters call application services
   - delivery adapters read durable state and publish outward

### Phase 3: Build the broker-facing channels

Recommended order:

1. Telegram adapter
   - easiest high-value broker surface
   - use it for intake, quick lookup, and daily brief delivery
2. Omi recorder ingest
   - convert device transcripts into the same ingestion contract as voice memos
3. Obsidian publisher
   - downstream status/meeting/market notes only
   - never make Obsidian the system of record
4. Hermes/Vermes bridge
   - treat it as another interaction adapter over application services

## Recommended Product Framing

The clean framing for the team is:

- Soleil is the core intelligence brain.
- Sullivan Link is the broader operating system around that brain.
- Adapters and tools are either feeding Soleil or exposing Soleil.
- Obsidian is a narrative mirror.
- Telegram, Hermes/Vermes, MCP, and future UI are front doors.
- PropertyRadar, `realestatetool`, Omi, title docs, and imports are intake pipes.

That framing keeps the repo understandable as more people commit into it.

## Immediate Next Actions

If the goal is to move fast without breaking the core, the next five concrete tasks should be:

1. create `src/app/` and move ingestion/matching/document orchestration into shared services
2. lock down privileged routes and deployment defaults
3. add a real outbound adapter layer for Telegram and Obsidian
4. add a queue/worker pattern for matching, alerts, and sync jobs
5. implement Monday and Hermes/Vermes as adapters over the same application services

## Bottom Line

Soleil is no longer a concept-only repo.
It is already a working intelligence backend with ingestion, matching, and narrative machinery.

The correct next move is not to keep building isolated features inside the core.
The correct next move is to harden the core and then connect the broker-facing channels and automation rails around it in a disciplined way.
