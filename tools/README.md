# Tools

`tools/` contains standalone utilities, bulk exports, and investigative workflows that support Sullivan Link but are not part of the default live runtime.

The main app runtime lives under `src/`, with entry points in `scripts/`, PM2 configuration in `ecosystem.config.cjs`, and external surfaces through the API, CLI, MCP, Telegram, and channel ingress routes.

## Current Tool Buckets

- `broker-email-lookup/`
  - one-off outreach enrichment for broker emails and related exports
- `llc-manager-finder/`
  - LLC manager lookup, contact hunting, and optional CRM import workflow
- `realnex-crm/`
  - Python RealNex client and local CRM dump workflows

## Promotion Rule

If a tool becomes part of the product, do not leave it here indefinitely.

- adapter logic goes in `src/integrations`
- orchestration goes in `src/app`
- long-running jobs go in `src/ops`
- user-facing access goes in `src/api`, `src/cli`, or `src/mcp`

## Handling Rule

Some tool folders contain bulky exports or sensitive operational data. Treat them as working material, not polished product surfaces.
