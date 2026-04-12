# Soleil Operator Skill

This file is the assistant-facing operating contract for using Sullivan Link Brain intelligently.

`AGENTS.md` and `CLAUDE.md` cover the narrative layer. This file covers runtime behavior: when to query, when to match, and when to write memory.

## Purpose

Use Soleil as an operational commercial real estate brain, not as a generic note bucket.

The system already has dedicated tools and routes for:

- assistant-style orchestration
- entity/property lookup
- fuzzy recall across knowledge
- buyer-property matching
- daily action prioritization
- explicit memory writes

Use the right one.

## Tool Selection Rules

### Use `brain_answer`

As the default front door for normal assistant conversation:

- "Who is Mike Chen?"
- "What should I do today?"
- "Find me Carson industrial buyers"
- "Save this: Mike Chen wants 30k sqft in Carson"

Use specialist tools below when you need a deterministic single-purpose call or tighter control over the exact operation.

### Use `brain_lookup`

For specific names or assets:

- "Who is Mike Chen?"
- "What do we know about Pacific Industrial Group?"
- "Pull up 5414 E FLORAL AVE"
- "Show me Special Default Services"

### Use `brain_search`

For fuzzy recall, themes, or broad history:

- "Who wanted industrial near Carson?"
- "Search my notes for lenders active in Selma"
- "What do we know about SBA buyers?"

### Use `brain_match`

For fit and counterpart questions:

- "Who matches this property?"
- "Find buyers for 5414 E FLORAL AVE"
- "What properties match Mike Chen?"

### Use `brain_daily`

For prioritization and workflow:

- "What should I do today?"
- "What are my priorities?"
- "Give me the daily brief"

### Use `brain_status`

For runtime and environment checks:

- "Is Soleil healthy?"
- "Is the database up?"
- "What inference provider is active?"

### Use `brain_realnex_disambiguate`

When you need to connect a local person or company to likely RealNex CRM records:

- "Which RealNex contact is this Mike Chen?"
- "Disambiguate Pacific Industrial against RealNex"
- "Find the closest RealNex record for this email and company"

### Use `brain_add`

Only when the user is clearly providing new information to store:

- "Save this: Mike Chen wants Carson industrial, 30k sqft, SBA"
- "Add a note that Special Default Services called back"
- "Remember that Ken Kahan is price-sensitive"

## Do Not Use `brain_add`

Do not store these by default:

- greetings
- "yo you working bro"
- corrections like "nah don't save"
- status checks
- questions that should be answered with lookup/search/match/daily

If the user asks a question and also includes new facts, answer the question first. Only store the facts if the user clearly intends that.

## Telegram Policy

Telegram should mirror the same policy:

- slash commands are explicit
- plain text should go through `brain_answer`-style intent routing first
- explicit save language should be required for note capture when intent is ambiguous

Good:

- `who is Mike Chen`
- `what should I do today`
- `save: Mike Chen wants Carson industrial`

Bad:

- storing `yo you working bro`
- storing `nah dont save`

## Runtime Boundary

Use the live app surfaces, not standalone utility folders.

Primary runtime:

- `src/api`
- `src/app`
- `src/mcp`
- `src/cli`
- `src/ops`
- `src/integrations`

Standalone/adjacent utilities:

- `tools/`

If a capability matters to the product, it should be promoted into the runtime surfaces above instead of staying buried in `tools/`.
