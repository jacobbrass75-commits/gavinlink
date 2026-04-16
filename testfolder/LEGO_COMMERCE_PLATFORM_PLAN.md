# LEGO Commerce Platform Plan

Last updated: April 15, 2026

## Goal

Build an internal platform that becomes the source of truth for:

- inventory
- purchases and cost basis
- channel listings
- sales ingestion
- stock adjustments
- AI-assisted pricing, listing, and purchasing workflows

The platform should connect BrickLink, eBay, Whatnot, and Airtable without relying on those systems as peer-to-peer sources of truth.

## Recommendation

The best approach is to build a central inventory and purchasing system first, then treat BrickLink, eBay, and Whatnot as channel adapters.

Recommended v1 stack:

- Backend: Python 3.12, Django 5, Django admin
- API layer: Django Ninja or DRF
- Database: PostgreSQL
- Jobs: Celery + Redis
- Storage: S3-compatible object storage for images and purchase documents
- AI layer: OpenAI Responses API, but only for suggestions and operator workflows
- Deployment: one fixed-IP Linux host or container setup with static egress

Why this stack:

- It is easier for a medium-tier model to implement safely than a split frontend/backend/serverless stack.
- Django admin gives you an internal operations UI immediately.
- Python is a good fit for marketplace adapters, ETL, and AI-assisted workflows.
- BrickLink requires registered static IP addresses for API access, which makes pure serverless a bad default.

## Core Design Rules

1. Your app is the source of truth for stock.
2. Marketplaces are projections of your stock, not co-equal masters.
3. AI does not directly mutate inventory.
4. All inventory writes go through deterministic service functions and are logged.
5. Every sale, purchase, manual adjustment, import, and sync creates an inventory ledger event.
6. Whatnot should be CSV-first unless you already have Seller API preview access.

## What To Build First

Build v1 around these jobs:

- import inventory from BrickLink
- import listings and orders from eBay
- import Whatnot sales and listings via CSV or API, depending on access
- sync selected operational data to Airtable
- maintain one internal SKU/catalog model
- maintain one inventory ledger
- publish quantity and price updates back to BrickLink and eBay
- generate Whatnot-ready CSV exports
- track purchases, cost basis, and sell-through

Do not start with:

- bundle logic
- complex repricing automation
- full autonomous AI agents
- live Whatnot real-time show automation
- cross-marketplace listing creation for every item type on day one

## Best Practical Architecture

### 1. Internal source-of-truth model

Use these core entities:

- `catalog_item`
  - normalized product identity
  - for LEGO this should support sets, minifigs, parts, accessories, and mixed lots
- `inventory_lot`
  - one acquired lot or stock bucket with quantity, condition, cost basis, and location
- `channel_listing`
  - one marketplace listing or offer tied to one internal sellable SKU
- `inventory_reservation`
  - temporary reserved stock for open orders or in-progress channel syncs
- `inventory_event`
  - append-only stock movement log
- `purchase`
  - acquisition record with supplier, cost, fees, and notes
- `sale`
  - normalized order header
- `sale_line`
  - normalized order line
- `channel_account`
  - credentials and settings per marketplace
- `sync_run`
  - job history, errors, and retry metadata

### 2. Canonical inventory rule

Track available stock as:

`on_hand - reserved = available`

Channel quantity should be derived from internal availability, not entered manually on each marketplace forever.

### 3. Channel adapter pattern

Create one adapter per marketplace with a common interface:

- `pull_inventory()`
- `pull_orders()`
- `push_listing_update()`
- `push_quantity_update()`
- `push_price_update()`
- `acknowledge_webhook_or_notification()`
- `healthcheck()`

Keep marketplace-specific logic out of your inventory core.

### 4. Fixed-IP deployment

BrickLink API access depends on registered static IP addresses. That means your production integration should run from a fixed egress IP, or BrickLink calls may fail.

Best deployment choice for v1:

- one VPS or cloud VM with a static public IP
- Docker Compose
- Nginx
- Django app
- Celery worker
- Redis
- PostgreSQL

If you want a nicer cloud setup later, you can split services later. Do not start there.

## Marketplace Strategy

### BrickLink

Use BrickLink for:

- inventory import
- order import
- order status updates
- inventory quantity and price updates
- push notifications plus polling fallback

Important implementation notes:

- BrickLink uses OAuth 1.0 credentials plus registered static IPs.
- BrickLink push notifications do not guarantee delivery, so keep a periodic poller as a safety net.
- For LEGO-specific identity, preserve BrickLink item number, item type, color ID, and condition.

Recommended v1 behavior:

- nightly full inventory reconciliation
- frequent order polling
- notification endpoint for order events
- idempotent inventory update jobs

### eBay

Use eBay for:

- listing and offer management through the Inventory API
- order ingestion through the Fulfillment API
- shipment tracking pushback through the Fulfillment API
- optional notifications for order confirmation

Important implementation notes:

- If you create listings through eBay Inventory API, revisions should continue through the API, not Seller Hub.
- eBay requires business policies for Inventory API-based listing flows.
- eBay can support notifications, but polling orders by modification time is still a good fallback.

Recommended v1 behavior:

- import existing listings and map them to internal SKUs
- ingest orders every few minutes
- push quantity changes from internal stock
- defer aggressive repricing until after stock sync is stable

### Whatnot

Treat Whatnot differently from day one.

Recommended default:

- use Seller Hub CSV import/export workflows first
- optionally add Seller API support only if you already have access

Why:

- Whatnot Seller API is currently in developer preview
- Whatnot says it is not accepting new applicants for access
- their listing and inventory workflows are still evolving

Recommended v1 Whatnot behavior without API access:

- generate Whatnot CSV files from internal inventory
- store channel-ready image URLs in object storage
- import ledger or order exports back into your platform
- optionally import show-specific temporary listings via CSV

Recommended v2 Whatnot behavior with API access:

- add a GraphQL adapter
- ingest sale notifications
- create and update products/listings through the API

### Airtable

Yes, Airtable can be connected, but it should be treated as a secondary operations surface.

Best use cases for Airtable:

- sourcing pipeline
- purchase intake queue
- listing review queue
- manual exception handling
- KPI dashboards for non-technical operators
- lightweight mobile-friendly ops views

Do not use Airtable as:

- the source of truth for stock counts
- the only place where purchases are recorded
- the system that decides channel quantity

Recommended Airtable behavior:

- your app writes selected records to Airtable for visibility and workflow
- Airtable writes back only limited approved fields such as notes, tags, review status, or sourcing decisions
- stock quantities, reservations, and cost-basis calculations stay in PostgreSQL

Implementation notes:

- use Airtable Personal Access Tokens for your own internal connection
- use OAuth only if you later build a third-party Airtable integration for other users
- Airtable Web API is rate-limited to 5 requests per second per base
- Airtable also supports webhooks, which is useful for reacting to changes in review/status tables

Recommended Airtable tables for v1:

- Purchases Queue
- Inventory Review
- Channel Listing Review
- Sync Exceptions
- Pricing Suggestions
- KPI Snapshot

Recommended sync direction for v1:

- PostgreSQL -> Airtable for dashboards and operator workflows
- Airtable -> PostgreSQL only for human-entered metadata and approval fields

That gives you the convenience of Airtable without corrupting inventory truth.

## LEGO-Specific Data Model Advice

This matters more than the tech stack.

Your canonical SKU model should support:

- set number
- part number
- minifig ID
- BrickLink item type
- color
- condition
- completeness
- sealed vs opened
- location/bin
- acquisition lot

Practical rule for v1:

- support one internal SKU to one sellable marketplace listing
- do not support bundles or mixed-lot decomposition in the first build

That keeps stock math sane.

Example canonical identifiers:

- `SET-10274-NEW-SEALED`
- `MINIFIG-SW0001-USED-COMPLETE`
- `PART-3001-COLOR5-USED`

You do not have to expose these exact identifiers to customers. They are for internal stability.

## Purchasing And Cost Basis

This is the part most reseller tools get weak.

Track purchases with:

- seller or source
- acquired date
- total cost
- shipping cost
- marketplace fees
- notes
- linked receipt or invoice files
- linked inventory lots created from that purchase

Each sale should calculate:

- gross revenue
- channel fees
- shipping charged
- shipping cost
- net proceeds
- allocated cost basis
- gross margin

If you skip this early, the AI layer will have poor data and give bad purchasing suggestions.

## AI Layer

AI should sit on top of the structured system, not replace it.

Good v1 AI features:

- natural-language dashboard queries
- listing title and description drafting
- suggested channel fit by item type
- purchase review assistant for incoming lots
- anomaly detection for stock mismatches
- suggested reorder or sourcing priorities based on sell-through and margin

Do not allow v1 AI to:

- directly publish listings without operator approval
- directly edit stock counts without a human confirmation path
- perform silent repricing

Best implementation pattern:

- AI proposes
- service layer validates
- user confirms
- deterministic code writes

## Phased Build Plan

### Phase 0: Foundation

Deliverables:

- Django project scaffold
- PostgreSQL schema
- Django admin
- Redis and Celery
- environment-based secrets setup
- S3-compatible file storage

Exit criteria:

- app boots locally and in Docker
- admin login works
- base models and migrations are in place

### Phase 1: Internal Inventory + Purchasing Core

Deliverables:

- catalog items
- inventory lots
- purchases
- inventory event ledger
- stock availability calculation
- manual adjustments UI

Exit criteria:

- you can create inventory manually
- you can record purchases
- stock math is correct and auditable

### Phase 2: BrickLink Read Sync

Deliverables:

- BrickLink auth
- inventory import
- order import
- notification endpoint
- poller fallback
- SKU mapping tables

Exit criteria:

- BrickLink inventory imports cleanly
- new BrickLink orders reduce available stock internally

### Phase 3: eBay Read + Write Sync

Deliverables:

- eBay OAuth flow
- listing import
- order import from Fulfillment API
- quantity push
- shipment tracking push

Exit criteria:

- eBay orders decrement internal stock
- internal stock changes update eBay quantities

### Phase 4: Whatnot CSV Workflow

Deliverables:

- Whatnot CSV exporter
- image URL hosting workflow
- import pipeline for Whatnot ledger or order exports
- show-specific export templates

Exit criteria:

- you can publish Whatnot-ready CSVs from internal inventory
- Whatnot sales can be imported back into the system

### Phase 5: AI Assistant

Deliverables:

- chat UI or admin action panel
- prompt templates grounded in your database
- purchase review workflow
- listing generation workflow

Exit criteria:

- AI answers are grounded in your actual data
- AI actions always pass through explicit approval

### Phase 5.5: Airtable Ops Sync

Deliverables:

- Airtable base design for ops workflows
- outbound sync from PostgreSQL to Airtable
- limited inbound sync for approved human-entered fields
- webhook or polling support for Airtable status changes

Exit criteria:

- operators can manage sourcing/review work in Airtable
- Airtable changes cannot silently alter inventory truth

### Phase 6: Optional Whatnot API Adapter

Only do this if you already have Seller API access.

Deliverables:

- GraphQL client
- product and listing sync
- sale notification ingestion

Exit criteria:

- Whatnot API access is stable enough to replace some CSV flows

## Recommended Build Order For A Medium-Tier Model

Tell the implementation model to do this in order:

1. Scaffold Django, Postgres, Redis, Celery, Docker Compose, and Django admin.
2. Create the inventory core models and migrations.
3. Build stock calculation and inventory event services.
4. Add purchase intake and cost basis tracking.
5. Add BrickLink adapter in read-only mode first.
6. Add eBay adapter in read-only mode first.
7. Add write-back sync for BrickLink and eBay quantities.
8. Add Whatnot CSV export/import workflows.
9. Add Airtable ops sync for review queues and dashboards.
10. Add AI query and listing-draft workflows last.

That ordering minimizes risk and gives you a usable internal system before automation starts mutating channel inventory.

## Initial Backlog

- create Django project and settings split
- add Docker Compose for app, db, redis, worker
- create base apps: `catalog`, `inventory`, `purchasing`, `channels`, `sales`, `ai`
- add UUID primary keys
- add audit timestamps and soft-delete where useful
- create `inventory_event` as append-only
- create service layer for reserve, release, decrement, increment, reconcile
- create admin dashboards for stock, purchases, and sync failures
- add BrickLink credential storage and signing utility
- add eBay OAuth token refresh flow
- add Whatnot CSV generator and importer
- add Airtable sync service for review/status tables
- add product image storage with public HTTPS URLs
- add error reporting and retry queue for sync jobs

## Hard Risks To Handle Early

### 1. BrickLink hosting choice

If you deploy on infrastructure without fixed egress, BrickLink can become the blocker.

### 2. SKU mapping mistakes

If the same real item maps differently across channels, oversells and bad reporting follow quickly.

### 3. Whatnot expectations

Do not promise real-time full API sync unless you already have Seller API access.

### 4. eBay ownership of listing state

Once you use eBay Inventory API for a listing workflow, keep that listing managed through your system.

### 5. Inventory bundles

Bundles, lots, and decomposed sets should be deferred until the base ledger is proven.

### 6. Airtable scope creep

If Airtable becomes the place where people “just fix stock quickly,” your system will drift. Keep its write-back fields narrow.

## Definition Of Success

The project is successful when:

- internal available stock is trustworthy
- BrickLink and eBay stock reflect internal stock
- Whatnot can be operated without duplicate manual entry
- Airtable gives you a usable ops layer without becoming a second database of truth
- purchases and profitability are visible per item or lot
- AI helps you decide what to buy, list, and move, instead of guessing

## Copy-Paste Handoff Prompt For A Medium Model

```text
Use /Users/yakub/Desktop/sullilink/testfolder/LEGO_COMMERCE_PLATFORM_PLAN.md as the source of truth.

Implement this project in phases, starting with Phase 0 and Phase 1 only.

Tech requirements:
- Python 3.12
- Django 5
- PostgreSQL
- Redis
- Celery
- Docker Compose
- Django admin

Rules:
- The internal database is the source of truth for inventory.
- Do not build bundle logic yet.
- Do not build autonomous AI actions yet.
- Do not implement Whatnot API access unless credentials and access are confirmed.
- Treat Airtable as an ops/reporting layer, not the stock source of truth.
- Prefer simple, auditable service-layer code over abstraction-heavy design.

First deliverable:
- scaffold the project
- create apps for catalog, inventory, purchasing, channels, sales, ai
- add Docker Compose
- add initial models and migrations
- add Django admin registrations
- implement inventory event ledger and stock calculation services

After that, stop and summarize what was built, what migrations were added, and what the next smallest safe step is.
```

## Sources

- BrickLink API Manual: https://static.bricklink.com/alpha/default/api_wiki.html
- eBay Inventory API Overview: https://developer.ebay.com/api-docs/sell/inventory/overview.html
- eBay Fulfillment API Overview: https://developer.ebay.com/api-docs/sell/fulfillment/static/overview.html
- eBay Notification API Overview: https://developer.ebay.com/api-docs/buy/notification/overview.html
- Whatnot Seller API Introduction: https://developers.whatnot.com/docs/getting-started/introduction
- Whatnot Inventory docs: https://developers.whatnot.com/docs/information/inventory
- Whatnot CSV bulk import guide: https://help.whatnot.com/hc/en-us/articles/7440530071821-Bulk-import-products-from-a-CSV-file
- Whatnot cross-listing via Vendoo guide: https://help.whatnot.com/hc/en-us/articles/14064450060941-Import-listings-from-other-marketplaces-using-Vendoo
- Airtable Web API guide: https://support.airtable.com/docs/public-rest-api
- Airtable Personal Access Tokens: https://support.airtable.com/docs/how-do-i-get-my-api-key-
- Airtable Webhooks API overview: https://support.airtable.com/docs/airtable-webhooks-api-overview
- Airtable OAuth overview: https://support.airtable.com/docs/third-party-integrations-via-oauth-overview
