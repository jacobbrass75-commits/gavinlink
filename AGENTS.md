# ISG Narrative Layer

This repo uses a Karpathy-style `raw/` + `wiki/` + `AGENTS.md` pattern as a narrative layer over the structured Second Brain.

The inspiration is Andrej Karpathy's lightweight local wiki workflow, adapted here so the wiki is a human-readable synthesis layer while PostgreSQL remains the source of truth for structured facts. Reference: [karpathy/How I use LLMs](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## Source Of Truth

- PostgreSQL is authoritative for structured state: properties, entities, buyer profiles, seller profiles, matches, distress scores, and linked documents.
- ChromaDB is authoritative for embedding-backed recall and semantic search.
- `raw/` is the immutable source drop zone for transcripts, reports, exports, PDFs, and other primary materials.
- `wiki/` is a curated narrative layer. It must never silently override structured database truth.
- Obsidian is a downstream publishing target only. It must not be treated as a competing source of truth.

## Citation Rules

Every substantive claim in `wiki/` must include at least one source token:

- `[ke:<knowledge_entries.id>]` for a knowledge entry already stored in Postgres
- `[raw:<filename>]` for a file under `raw/`

Optional narrative references:

- `` `APN 123-456-789` `` for parcel references
- `` `property_id <uuid>` `` for direct property references

Rules:

- Any numeric claim should have a citation on the same line whenever possible.
- If a page mentions a conversation, memo, or imported note, cite the specific `knowledge_entries.id`.
- If a page summarizes a PDF or other file that has not yet been routed into `knowledge_entries`, cite the raw file name.
- If a note arrived through Telegram, Hermes, Omi, Vermes, Gmail, or another channel and was ingested into Postgres, cite the resulting `[ke:...]` entry rather than the transport itself.
- If the database and wiki disagree, the database wins. Update the wiki page rather than mutating the DB to fit a narrative.

## Folder Intent

- `raw/`
  - immutable drop zone for transcripts, exports, reports, PDFs, and broker notes before or after ingestion
- `wiki/players/`
  - broker-facing pages on people, owner entities, principals, recurring operators
- `wiki/lenders/`
  - trustee, lender, servicer, and foreclosure operator pages
- `wiki/submarkets/`
  - market and submarket narrative pages
- `wiki/playbooks/`
  - tactical outreach and negotiation playbooks
- `wiki/patterns/`
  - recurring lender-owner patterns, deal archetypes, and post-mortems
- `wiki/properties/`
  - narrative context for specific properties or grouped parcels

## Promotion Workflow

Use the CLI to promote high-signal knowledge into the wiki:

```bash
brain promote <knowledge_entry_id>
brain promote <knowledge_entry_id> --page wiki/playbooks/distressed-llc-approach.md
brain promote <knowledge_entry_id> --title "Special Default Services"
```

Promotion rules:

- Prefer updating an existing page instead of creating near-duplicates.
- Keep the promoted narrative concise and sourced.
- Treat the latest promoted block as an update, not a full rewrite of page history.
- Promote only distilled knowledge, not raw transcript dumps.

## Lint Workflow

Use:

```bash
brain lint
brain lint --offline
```

`brain lint` checks:

- missing citations
- missing `## Sources` sections
- broken `[ke:...]` references
- missing `[raw:...]` files
- pages not referenced from `wiki/index.md`
- numeric lines without citations as warnings

## Writing Style

- Write for broker meeting prep, not for academic completeness.
- Prefer specific, operational phrasing over generic summaries.
- Keep factual statements attributable.
- If something is an inference, say that plainly.

## Guardrails

- Never invent ownership counts, portfolio totals, or lender behavior trends without citations.
- Never store secrets or API keys in `raw/` or `wiki/`.
- Do not copy full transcripts into `wiki/`; summarize and cite instead.
- Use the importer and property document flows for structured property evidence. The wiki complements them; it does not replace them.

## Assistant Operating Rules

When an assistant is operating Soleil through the API, CLI, MCP, or Telegram-facing adapters:

- Prefer `brain_answer` as the default conversational front door.
- Prefer `brain_lookup` for specific person, company, LLC, lender, or property questions.
- Prefer `brain_search` for fuzzy recall, conversation history, and broad "what do we know about..." requests.
- Prefer `brain_match` for buyer-property fit or who-matches-this questions.
- Prefer `brain_daily` for priority and workflow questions.
- Use `brain_add` only when the user is explicitly providing new information to store or asks to save/update memory.
- Do not treat greetings, corrections, status checks, or "don't save that" messages as note-ingestion requests.
- Treat `tools/` as standalone utility code and archived workflows, not as the default live runtime surface.
