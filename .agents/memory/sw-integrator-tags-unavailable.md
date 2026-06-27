---
name: Shop-Ware integrator_tags (line-level PCDB) unavailable in practice
description: Why SW per-line PCDB/PartsTech IDs never populate for currently-connected shops, and why dev can't live-verify it.
---

# Shop-Ware line-level PCDB (`integrator_tags`) is effectively unavailable

The SW webhook requests the `services.parts.integrator_tags` association and
`extractShopWarePcdb` maps it, but **no connected SW shop actually surfaces
tags**, so SW line-level PCDB stays empty.

**Why:** `integrator_tags` only populate when a shop runs a PartsTech-style
catalog integration. None of the connected SW shops do — shop-level
`integrator_tags` is `[]` everywhere reachable, and their parts are
hand-entered/non-catalog (no PCDB/PartsTech fields; descriptions like "Misc
Bolts"). Across all cached prod SW ROs (tens of thousands, ~67k with parts),
zero parts carry the key. `extractShopWarePcdb` is correct but has nothing to
map; this is an inherent data gap, not a bug. It will only fill if an SW shop
onboards a catalog integration.

**Caveat on the cache signal:** `shopware_repair_orders.raw` is last-written by
the backfill/prewarm path (`lib/shopware-jobs-prewarm.ts`), which fetches with
the **base** association set (no `integrator_tags`). So cache-zero reflects the
backfill path, not the webhook's enriched fetch — the dispositive signal is the
absence of any catalog integration, not the cache count alone.

**Why dev can't live-verify the enriched fetch:** dev SW creds are
sandbox-scoped (`SHOPWARE_USE_SANDBOX=true`; prod API returns 401). The SW
`...parts.integrator_tags` association is also intermittently HTTP 500 (the exact
flakiness the webhook's degrade-once logic guards against). To truly confirm the
webhook path on prod data you need prod SW creds or prod log access (the webhook
logs a degrade warning when the association is rejected). `production_logs` is
not mirrored to the dev PG.

**How to apply:** Don't treat empty SW line-level PCDB as a regression. If asked
to "fix" it, the only real fix is an SW shop adopting a PartsTech-style catalog —
or pulling/re-pulling ROs with the enriched association from prod creds. See
`docs/runbooks/job-index-aces-pcdb-parity.md`.
