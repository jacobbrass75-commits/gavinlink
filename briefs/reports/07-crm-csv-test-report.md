# ISG Second Brain — CRM CSV Test Report And Build Plan

## Executive Summary

We tested the current ISG Second Brain against a real foreclosure CSV export:

- File: `/Users/brass/Downloads/Property_639111096199371268.csv`
- Format: UTF-16 LE CSV
- Real rows: 745
- Shape: foreclosure property inventory, not buyer/contact CRM data

The system handled the file well enough for exploratory note ingestion, but **not yet as a structured property import**.

What worked:

- The API, Postgres, and ChromaDB were running and healthy.
- Conversational ingestion accepted 5 real rows with live Claude classification.
- Knowledge entries were created correctly.
- Lender/trustee entities were created correctly.
- No duplicate entity names were introduced by the 5-row test.
- Semantic search / Chroma storage issues were identified and fixed locally.

What did not work for this file:

- The 5 imported rows did **not** create new `properties`.
- The 5 imported rows did **not** create `seller_profiles`.
- Some property references were treated as free-standing entities instead of linked properties.
- This means the current pipeline is good for **capturing notes**, but not yet good for **bulk structured foreclosure imports** from messy external CSVs.

Bottom line:

The core backbone is real and useful, but the missing piece is a **dedicated structured property import path** for third-party CSVs. Until that exists, the system is best used for:

- broker notes
- buyer updates
- seller context on known properties
- knowledge search
- entity graph building
- matching against already-structured data

not blind bulk loading of new foreclosure inventory.

---

## Can We Do Groupings Yet?

### Yes, but only in two limited ways right now

### 1. CSV-level groupings

We can absolutely group the raw CSV before import. That is already useful.

Examples from this file:

#### Top cities

- `LOS ANGELES`: 121
- `Los Angeles`: 83
- `SAN DIEGO`: 25
- `LONG BEACH`: 16
- `IRVINE`: 12

This immediately shows one cleanup issue: city casing is inconsistent, so the true Los Angeles count is higher than either row alone.

#### Top trustees

- `CALIFORNIA TD SPECIALISTS`: 59
- `TOTAL LENDER SOLUTIONS INC`: 50
- `BEACON DEFAULT MANAGEMENT INC`: 40
- `FIRST AMERICAN TITLE INS CO`: 37
- `PEAK FORECLOSURE SERVICES INC`: 29

#### Top beneficiary/client names

- `NO LENDER ON DOCUMENT`: 91
- `NANO BANC`: 14
- `HANKEY CAPITAL LLC`: 11
- `LONE OAK FUND LLC`: 7
- `ENTERPRISE BANK and TRUST`: 6

#### Duplicate APN clusters

There are 64 duplicate APN rows in the file.

Examples:

- `8139-016-024`: 3
- `5503-007-024`: 3
- `5547-017-044`: 3
- `5132-001-120`: 3
- `7429-007-017`: 2

So yes, we can group by city, trustee, beneficiary, APN duplicates, and casing/name normalization issues today.

### 2. Knowledge/entity-level groupings

From the 5-row exploratory import, we can group:

- imported knowledge entries by date/source
- linked entities by lender/trustee name
- entity relationship patterns created by ingestion

But we **cannot yet** do the more important grouping:

- property portfolios
- seller clusters
- property-level distress rollups
- APN/address grouping inside the structured property table

because these 5 imported records were not inserted into `properties`.

### Current reality

We can group:

- raw CSV records
- ingested notes
- created entities

We cannot yet reliably group:

- imported foreclosure properties as structured assets
- newly imported seller opportunities
- portfolio clusters from those new rows

---

## Phase 4 Report

## 1. CSV Summary

### File shape

- `745` usable rows
- `11` columns
- UTF-16 LE encoding
- property-centric foreclosure export

### Columns

- `property_key`
- `Address`
- `City`
- `Sale Date`
- `APN`
- `Bene/Client Name`
- `Foreclosure Document Type`
- `Trustee Name`
- `Trustee City`
- `Trustee Phone #`
- `Use`

### Data quality issues

- `64` duplicate-looking property rows by APN/exact record
- `30` cities with casing variants like `LOS ANGELES` vs `Los Angeles`
- `1` suspicious blank address
- `1` suspicious `NA YORBA LINDA BLVD` address
- `Trustee City` is blank for all rows
- `Foreclosure Document Type` is blank for all rows
- `Use` is blank for `739/745` rows
- `Sale Date` missing for `369/745`
- `Bene/Client Name` missing for `33/745`
- `Trustee Name` missing for `12/745`
- `Trustee Phone #` missing for `76/745`
- phone formats are mixed:
  - plain digits
  - dashed
  - parenthesized
- name punctuation/casing varies:
  - `ENTERPRISE BANK and TRUST` vs `ENTERPRISE BANK AND TRUST`
  - `BEACON DEFAULT MANAGEMENT INC` vs `BEACON DEFAULT MANAGEMENT, INC`
  - `S.B.S. TRUST DEED NETWORK` vs `SBS TRUST DEED NETWORK`

## 2. What Was Imported And How

### Strategy used

We used a **hybrid exploratory path**:

- selected the first 5 valid rows
- converted each row into a plain-English distressed property note
- sent each one to `POST /api/ingest`
- allowed Module 5 classification + routing to decide what to create

### Result

All 5 calls returned HTTP 200.

They created:

- `5` knowledge entries
- `9` entities
- `6` entity relationships

They did **not** create:

- new `properties`
- `seller_profiles`
- `buyer_profiles`

## 3. What Worked, What Didn’t, What Looked Weird

### What worked

- Live Claude classification responded successfully.
- The knowledge layer is usable.
- The system extracted lender/trustee names and created entities.
- Entity dedupe held: no duplicate entity names from the 5-row test.
- Chroma metadata handling was repaired for empty arrays.
- Semantic search is now operational again.

### What didn’t

- New property rows were not created for unseen APNs.
- Seller profiles were not created for these imported foreclosure rows.
- The conversational ingestion route is not a bulk property import tool.

### What looked weird

- Some rows produced address-like entities such as:
  - `21747 ERWIN ST, WOODLAND HILLS`
  - `6221 Fallbrook Ave, Woodland Hills`
- One record with `NO LENDER ON DOCUMENT` did not create a beneficiary entity, which is probably correct semantically, but it means downstream logic has to tolerate null lender identity.
- Bank names like `JPMORGAN CHASE BK NA` came in as `unknown` type, which is acceptable but not ideal.

## 4. Recommendation

### Should we proceed with a full import right now?

**No, not through `/api/ingest`.**

That path is good for broker notes and partial intelligence capture, but it is not safe for a full structured foreclosure import from this CSV.

### What should happen next

Build a dedicated CSV import path that:

1. decodes UTF-16 correctly
2. normalizes casing, punctuation, and phone formats
3. dedupes by `(APN, region)` or APN/address rules
4. inserts rows into `properties`
5. upserts beneficiary/trustee entities
6. links those entities to properties
7. optionally creates seller profiles for obviously distressed rows
8. creates a knowledge entry per imported record only as a supplement, not the primary record

### Cleanup needed before full import

- city normalization
- phone normalization
- trustee/beneficiary name normalization
- duplicate APN resolution strategy
- invalid address handling (`NA ...`, blank)
- explicit mapping for `Sale Date`

## 5. Estimated Time And Cost For Full Import

### If we keep using conversational ingestion

- Time: high
- Reliability: low for structure
- Claude cost: non-trivial, because every row triggers inference
- Outcome: lots of notes, weak structured property data

Not recommended for 745 rows.

### If we build the proper importer

- Engineering time: about `1-2 focused days`
  - importer script / route
  - normalization layer
  - dry-run preview
  - validation queries
- Claude/API cost: near zero or optional
- Outcome: workable structured asset inventory

That is the right move.

## 6. Sample SQL Queries To Spot-check

### Check imported knowledge entries

```sql
SELECT id, title, source, created_at
FROM knowledge_entries
ORDER BY created_at DESC
LIMIT 20;
```

### Check duplicate entities

```sql
SELECT name, COUNT(*)
FROM entities
GROUP BY name
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC, name ASC;
```

### Check whether APNs actually made it into properties

```sql
SELECT apn, address, city
FROM properties
WHERE apn IN (
  '0318-212-27-0-000',
  '2146-029-017',
  '2166-014-020',
  '2039-013-061',
  '2115-019-003'
);
```

### Check which knowledge entries are linked to which entities

```sql
SELECT ke.id, ke.title, e.name, e.entity_type
FROM knowledge_entries ke
JOIN knowledge_entities kel ON kel.knowledge_entry_id = ke.id
JOIN entities e ON e.id = kel.entity_id
ORDER BY ke.created_at DESC, e.name ASC;
```

### Check top trustees after structured import exists

```sql
SELECT trustee_name, COUNT(*) AS property_count
FROM properties
WHERE trustee_name IS NOT NULL
GROUP BY trustee_name
ORDER BY property_count DESC
LIMIT 25;
```

## 7. Rollback Command For The Test Import

These 5 exploratory rows were stored as knowledge + entities, not structured properties.

### Safe targeted rollback

```sql
DELETE FROM knowledge_entries
WHERE id IN (
  '2e79bb56-a62b-44ec-be9e-b65af396a8e6',
  'e0e822e5-8439-440a-a872-2840a0f9a7f7',
  '191157a6-e7bb-4d4c-b4ea-c908d715d32d',
  '5f484580-3b2e-425c-a36f-da3956570245',
  '63b85d38-af71-4775-b7df-cfabbd05b2a0'
);
```

Then manually remove any now-orphaned entities created only for this experiment if desired.

## What Is Going On With The Build Right Now?

### The good news

The backbone exists:

- local infra
- DB schema
- entity extraction
- buyer engine
- seller engine
- knowledge base
- conversational ingestion
- matching engine

### The actual gap

The system is **strong on intelligence capture** and **weak on structured third-party CSV onboarding**.

That is why:

- broker-style notes work
- matching works on known structured data
- knowledge search works
- but this CRM foreclosure CSV only partially converts into structured system records

This is normal for the stage we are in. It means the foundation is real, but the import adapter is missing.

## Plan Forward To Get This Workable

## Phase A — Stabilize What Exists

Goal: preserve the working foundation.

- commit and push the live ingestion / Chroma fixes
- keep the repo green on tests
- stop using `/api/ingest` as the primary bulk loader for raw property feeds

## Phase B — Build A Dedicated Foreclosure CSV Importer

Goal: make outside property feeds usable.

- new dry-run import script or endpoint
- UTF-16 aware parsing
- field mapping config
- APN dedupe
- casing/punctuation normalization
- explicit property upsert into `properties`
- entity upserts for beneficiary/trustee
- optional seller profile generation

This is the highest-leverage next step.

## Phase C — Add Import Preview / Review Mode

Goal: make imports safe for the team.

- preview first N rows
- show duplicates before insert
- show missing required fields
- show normalized output before commit
- allow import in chunks

This turns the system from “smart prototype” into “tool we can actually use.”

## Phase D — Add Analyst-Friendly Grouping Reports

Once structured property import is working, add reports for:

- top trustees by count
- top lenders by count
- city concentration
- duplicate APN/address report
- portfolio clusters by shared lender or trustee
- distress queues by sale date proximity

## Phase E — Operational Workflow

Daily usable workflow should become:

1. import new foreclosure CSV into structured properties
2. auto-create/update entities and seller profiles
3. run matching
4. query top opportunities
5. add broker notes conversationally
6. search knowledge and relationship graph

That is the “workable” version of the system.

## Current Git Status

At the time of writing:

- code changes for the main modules are in git
- there were still local, uncommitted live-fix changes in the repo that needed to be committed before moving further
- `.env` and `node_modules` should stay out of git

The immediate next action is:

1. commit the local ingestion/provider/search fixes
2. push that branch
3. then build the dedicated CSV importer on top of that clean state

## Final Recommendation

Do **not** full-import this CSV through the conversational ingestion endpoint.

Do:

- keep the current backbone
- commit the live fixes
- build the dedicated foreclosure CSV importer next

That is the shortest path from “interesting prototype” to “something the team can actually use every week.”
