---
name: Shop-Ware backfill progress lives in collection `ln`
description: Which Mongo collection actually holds Shop-Ware backfill progress, and the latent bug in chunk-speed-health.
---

# Shop-Ware backfill progress collection

Shop-Ware per-shop backfill progress is stored in the oddly-named **`ln`**
collection (default app-data DB). That's what `shopware-backfill`,
`backfill-reconcile`, and `invoice-cache-refresh` all read/write.

**Latent gotcha:** `app/api/cron/backfill-chunk-speed-health/lib.ts` lists the
Shop-Ware collection as `shopware_backfill_progress`, which is effectively
empty — so that cron's Shop-Ware branch silently detects nothing. Any new
code that needs Shop-Ware progress must use `ln`, not
`shopware_backfill_progress`. (Tekmetric → `tekmetric_backfill_progress`,
Protractor → `backfill_progress` are correct everywhere.)
