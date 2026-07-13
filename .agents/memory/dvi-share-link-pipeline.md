---
name: DVI share-link ingestion pipeline
description: How third-party DVI report links (AutoServe1/AutoVitals/AutoFlow/MasterTech/AutoOps) are ingested into VHI, and the constraints that shaped it
---

# DVI share-link ingestion (lib/dvi-links/)

- **Everything is gated behind `DVI_LINK_INGEST_ENABLED` (default OFF)** — link
  registration in the Protractor sync hook, the 15-min fetch cron, and the
  sweep script all no-op without it. Flipping it on is an operator action
  (dev Mongo IS prod). Indexes are only created by the sweep script, never at
  runtime.
- **Why gated:** the pipeline writes to two new prod collections
  (`dvi_links`, gzip `dvi_link_snapshots`) and fetches third-party sites;
  nothing may fire from an isolated env.
- **Links expire at the provider** (confirmed: AutoFlow microsites return
  "Invalid id!"). Fetch cadence matters more than batch size; terminal states
  (`expired`/`blocked`) are recorded, never retried forever (3 attempts →
  expired).
- **Findings are advisory only:** required→red "0", suggested→yellow "1",
  fed through the existing dviFindings channel in all THREE plan-build paths
  (plan-build API, dashboard plan page, extension on-demand branch) via one
  shared helper — findings must NEVER become history anchors (an inspect
  finding must not reset a replace clock; same discipline as CARFAX).
- **Cache coupling:** adding per-item plan fields required bumping
  PLAN_CACHE_SCHEMA_VERSION (9→10) and extending the `dviSource` unions in
  triage + plan-cache; a new provider id means touching those unions too.
- **AutoServe1 public pages are Wayback-capturable** for fixtures, but the
  archived HTML has web.archive.org URL rewrites that must be stripped
  before parsing (see tests/dvi-link-parsers.smoke.ts).
- **AutoOps (aops.cc) links resolve to media**, not HTML reports — the
  fetcher classifies them `media` and no parser exists; MasterTech parser is
  best-effort.

**How to apply:** turning this on = run `npm run sweep:dvi-links -- --confirm`
(creates indexes + backfills links from protractor_invoice_cache), then set
`DVI_LINK_INGEST_ENABLED=true` in prod env. Health lives at
/platform-admin/dvi-links.
