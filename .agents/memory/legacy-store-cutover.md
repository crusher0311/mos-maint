---
name: Legacy pre-normalized store cutover
description: Flag gating + long-tail caveat for vehicles/customers/dvi/canned/concern/patterns/support_tickets Mongo→PG
---

The last data-bearing Mongo group is flag-gated via `lib/db/legacy-store-write-mode.ts` (`*_PG_CANONICAL` default OFF + `WRITE_MONGO_*` shadow default ON); mirrors in backfill-mongo-to-supabase.ts, parity `--domain=legacy`, runbook `docs/runbooks/db-legacy-store-cutover.md`.

**Key caveats:**
- Only the *central* vehicles/customers readers/writers went through the gated repos; a long tail of sync adapters, webhook/callback routes, and dashboard reads still hits Mongo directly. They stay correct only while Mongo shadow writes are ON — the vehicles domain needs delta backfills during soak, and the long tail must be folded before `WRITE_MONGO_LEGACY_VEHICLES=0` or the collections are dropped.
- support_tickets PG bridge: Mongo string ids via unique `mongo_id` column; the task-#344 route inserts PG-first with NULL mongo_id, so all gated/backfill inserts must conflict-merge on `ticket_number` (unique NOT NULL), never on mongo_id, or they collide with route-created rows.
- shop_repair_patterns wave2 PG stub modelled the wrong concept — real natural key is (shop, year, make, model, mileage_bucket, job_title_normalized); rolling-aggregate docs mutate in place so backfill mirror must refresh-on-conflict (keyed on backfill_mongo_id).
- Legacy `repair_orders`/`jobs`/`job_history` are RETIRED (readers repointed to normalized_work_orders, dead writes deleted) — don't resurrect readers.

**Why:** flipping flags or shadow-off without folding the long tail silently forks the two stores.
