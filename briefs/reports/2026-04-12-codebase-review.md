# Sullivan Link Brain Codebase Review

Date: 2026-04-12

## Executive Summary

The repo now has one real production runtime:

- Express API in `src/api`
- shared orchestration in `src/app`
- PM2 workers in `src/ops`
- CLI in `src/cli`
- MCP server in `src/mcp`

The core brain is real. The main remaining problem is not “missing intelligence.” It is boundary discipline:

- some legacy compatibility routes still exist
- some route families still bypass `src/app`
- several standalone `tools/*` workflows still look more official than they should
- the assistant is still an intent router, not a multi-step broker agent

## What The Program Actually Does

### Core system

Sullivan Link Brain stores structured brokerage intelligence in PostgreSQL and semantic recall in ChromaDB. The durable model includes:

- entities
- entity relationships
- properties
- buyer profiles
- seller profiles
- knowledge entries
- matches
- deals

### How information enters

The current intake paths are:

- manual note ingestion through `brain add`, `/api/ingest`, Telegram, and `brain_answer`
- foreclosure file import through `src/import-export/foreclosure-import.js`
- property alert ingestion from Gmail / PropertyRadar
- property document ingestion
- audio transcription and knowledge extraction
- RealNex import / sync
- webhook-style ingress from Omi, Hermes, and Vermes

### How information is used

The current output and interaction surfaces are:

- HTTP API
- CLI
- local MCP server
- Telegram bot
- recurring PropertyRadar feed worker
- wiki promotion and narrative maintenance
- Obsidian publishing

## How The Pieces Connect

### Canonical runtime path

```text
API / CLI / MCP / Telegram / Channel webhooks
  -> src/app/*
  -> domain modules in src/entities, src/buyers, src/sellers, src/knowledge, src/matching
  -> PostgreSQL + ChromaDB
  -> optional narrative promotion into raw/ + wiki/
```

### External adapters

- `src/integrations/realnex.js`
  talks to RealNex CRM and now supports live disambiguation plus sync/import into the brain
- `src/integrations/gmail.js`
  feeds PropertyRadar digest import
- `src/integrations/telegram.js`
  powers the bot worker
- `src/integrations/obsidian.js`
  publishes downstream notes
- `src/integrations/hermes.js` and `src/integrations/omi.js`
  normalize external event payloads for the shared channel layer
- `src/integrations/realestatetool.js`
  remains a supporting data adapter

### Narrative layer

- `raw/` is immutable evidence
- `wiki/` is downstream synthesis
- `AGENTS.md` defines the citation and promotion rules

The wiki is not a database replacement.

## Main Findings

### Fixed in this pass

- legacy `/brain/*` contract drift is reduced:
  - `/brain/entity/:id` now uses the real entity detail path
  - `/brain/import` and `/brain/export` now return explicit deprecation errors instead of fake Module 2 placeholders
- webhook assistant mode is now explicit instead of question-mark driven
- `allowSave: false` now really blocks RealNex write-side fallbacks in the assistant path
- MCP tool failures now surface as real errors instead of fake successful payloads
- Telegram update offsets no longer advance past per-message processing errors
- PropertyRadar only checkpoints Gmail message ids after the full message finishes
- stale PM2 logs were flushed locally and on the live server

### Still real issues

- many read routes are still open unless you enforce auth at a broader boundary
- `brain_answer` is still a single-turn intent router, not a planning agent
- some API families still reach into domain modules directly instead of going through `src/app`
- `tools/*` still contains committed operational data and one-off workflows that should be treated as artifacts, not product surfaces
- deploy success is still more reliable with direct SSH finish steps than with the detached finisher launcher in `deploy/deploy.sh`
- PropertyRadar is operationally correct, but still weak as a broker-facing signal surface when nothing new arrives

## Forward Plan

### 1. Normalize the runtime boundary

- move buyers, sellers, properties, knowledge, and matches behind explicit `src/app/*` facades
- keep `/api/*` canonical
- continue shrinking direct `/brain/*` compatibility

### 2. Harden product behavior

- make read auth consistent across external surfaces
- keep channel ingress deterministic
- add route-level observability that reports business outcomes, not just HTTP success

### 3. Upgrade the assistant

- build a planner/executor layer above `src/app/assistant.js`
- support multi-step flows like:
  - lookup
  - enrich from RealNex
  - search local knowledge
  - answer
  - optionally save if explicitly requested

### 4. Clean data hygiene

- move committed CRM dumps and progress files out of the main repo
- tighten ignore rules for generated tool outputs
- keep `README.md` and `ARCHITECTURE.md` as the current source of repo truth

### 5. Improve broker-facing usefulness

- make PropertyRadar summaries backlog-oriented instead of run-oriented
- surface unmatched alerts with clear reason codes
- make Telegram answer in plain language more reliably for lookup/search/summary questions

## Bottom Line

The repo is already a working brokerage intelligence backend. The next gains come from tightening runtime boundaries, removing historical drift, and upgrading the assistant from a router into a real operator layer.
