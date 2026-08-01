---
name: Shop-Ware progress collection
description: Which Mongo collection actually holds Shop-Ware backfill progress (ln vs shopware_backfill_progress) — flipped over time.
---

**Rule:** Shop-Ware backfill progress lives in Mongo `shopware_backfill_progress` (verified 2026-08-01: `ln` has 0 docs; `shopware_backfill_progress` has live per-shop docs with fresh `lastRunAt`). The historically odd `ln` collection is DEAD.

**Why:** an earlier era had the reverse (progress in `ln`), and stale comments survive: `app/api/cron/pipeline-stall-alerter/lib.ts` still documents `ln` as live and reads it for its Shop-Ware branch — that branch is therefore blind to Shop-Ware stalls. The flag-gated repo `lib/data/repositories/shopware-ops.ts` targets `shopware_backfill_progress` (correct).

**How to apply:** before trusting any "which collection is live" comment for Shop-Ware, count docs + check latest `lastRunAt` in both. Don't repoint stall detection to `ln`.
