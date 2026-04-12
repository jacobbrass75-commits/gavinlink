# Broker Email Lookup

One-off tooling built 2026-04-10 to enrich a CoStar multifamily-sales export with broker email addresses for outreach.

## Input

CoStar export of MF sales 2024-present, 415 deals × 74 columns, containing 382 unique (First, Last, Company) broker tuples.

File: `raw/broker-emails-2026-04-10/CostarExport_MF Sales_2024-Present.xlsx - Export041026.csv`

## Output

- `raw/broker-emails-2026-04-10/CostarExport_MF Sales_2024-Present_With_Emails.xlsx` — original CoStar export with `Listing Broker Email` and `Buyers Broker Email` columns inserted after the phone columns. Matches the original xlsx layout.
- `raw/broker-emails-2026-04-10/CoStar_Broker_Contacts.csv` — deduped mail-merge-ready contacts (one row per unique broker with email/phone/linkedin/role/deal count).
- `raw/broker-emails-2026-04-10/CoStar_Brokers_With_Emails.csv` — CSV equivalent of the xlsx.

## State

As of final run: **178/382 unique brokers verified (47%)**.

Source breakdown:
```
100  RocketReach (primary)
 28  Bing HTML name+company
 37  Pattern-fill (corp email patterns from verified samples)
 13  Bing HTML broader query
 12  RocketReach relaxed filter (pass 2)
  3  Bing HTML phone+name
  2  CompanySite domain guess
```

Remaining 204 are mostly solo agents at small shops with no meaningful public footprint. Four false positives were manually removed after review (law-firm/PE/off-company matches).

## Scripts (execution order)

All scripts read/write state to `broker_lookup_progress.json` (colocated). They're idempotent — skip brokers that already have an email.

1. **`broker_email_lookup.py`** — primary RocketReach API pass. Uses `ROCKETREACH_API_KEY` env var.
2. **`broker_rr_pass2.py`** — sequential RocketReach retry with relaxed filter (name + California only).
3. **`broker_rr_pass3.py`** — parallelized 3-thread RocketReach with global rate limiter (25/min).
4. **`broker_pattern_fill.py`** — detects corp email patterns (first.last, flast, etc.) from verified emails, backfills other brokers at the same company. Run after every successful external pass.
5. **`broker_bing_parallel.py`** — parallel Bing HTML scraper, 8 threads. Search `"name" "company" email`, extract URLs, fetch pages, match emails by name proximity.
6. **`broker_bing_phone.py`** — Bing with phone-number queries (phones pulled from the original CoStar CSV).
7. **`broker_company_scrape.py`** — guess company website from name, try common team URL paths, scrape.
8. **`broker_co_website.py`** — find company website via Bing search, then scrape team pages (didn't yield).
9. **`broker_ddg_search.py`** — DuckDuckGo version (abandoned, hit 202 rate limits).
10. **`broker_contacts_export.py`** — regenerate the deduped contacts CSV.
11. **`broker_xlsx_export.py`** — regenerate the final xlsx with email columns inserted.

## Paths

Scripts currently hardcode paths to `/Users/josephsullivan/Downloads/`. To rerun against the SulliLink copy, update `PROGRESS_PATH` / `INPUT_CSV` / `OUTPUT_*` constants at the top of each script.

## RocketReach notes

- Key was hardcoded in pass2/pass3 for this run — move to env var before any rerun.
- Daily quota ~750 person-searches. Hit once and returned `{"code":"throttled","wait":"~66000"}` (≈18h).
- Rate limit: 30/min per account.
- Strategy 1 (name + employer filter) works best. Strategy 2 (name + California only) catches a few more but adds noise.

## Validation rule

An email is accepted only if:
1. The broker's first or last name (≥3 chars) is in the local part, **OR**
2. The email domain contains a company word (≥4 chars, stopwords removed).

This rule produces false positives for brokers whose company name = their personal name (solo shops), where any matching name in the wild passes. Four such cases were hand-removed; watch for more on rerun.

## Future work

- Wait ~18h for RocketReach quota reset → rerun `broker_rr_pass3.py`.
- Try Hunter.io as a second provider (not attempted — no key).
- For the remaining 204, manual review is probably faster than more scraping.
