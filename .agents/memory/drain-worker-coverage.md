---
name: Backfill drain worker coverage (which providers, which service)
description: What the prod drain/background workers actually cover, and why a single lock snapshot can falsely look "off".
---

# Drain worker coverage

Two separate prod Render background_worker services exist — don't conflate them:

1. **`backfill-drain-worker`** (`srv-d86qipd7vvec73ahur00`, start `npm run worker:backfill-drain`
   → `scripts/backfill-drain-worker.ts`). Spawns BOTH provider drains in INDEPENDENT
   parallel loops: `PROVIDERS = [protractor, tekmetric]` (each spawns `npm run
   drain:<provider>-backfill`). Independent loops were the May-2026 fix so a fast
   Tekmetric crash isn't gated by a 15h Protractor run. So **Protractor IS drained
   continuously**, alongside Tekmetric — not Tekmetric-only.

2. **`mos-maint-background-v2`** (`srv-d8g15v3eo5us73fvajhg`, start `npm run worker`
   → `workers/worker.ts`). The BullMQ "v2" queue consumer. Registers 4 queues:
   TEKMETRIC_FULLPAGE, TEKMETRIC_PREPASS, DRAIN_TEKMETRIC, **DRAIN_PROTRACTOR**
   (singleton conc=1). So the v2 worker is also wired for Protractor drain (gated by
   REDIS_URL / `isQueueEnabled()`).

**Neither drains Shop-Ware** — Shop-Ware backfill is cron-only. So "the drain worker
covers all integrations" really means Tekmetric + Protractor, NOT literally all.

**Gotcha — don't conclude "drain is off" from one lock-doc snapshot.** The Protractor
drain cycles (spawn → run → exit → sleep → respawn) and works shops sequentially, so a
point-in-time check of a single drain lock can show "unheld" while the drain is very much
alive (confirmed 2026-06-07: lock looked unheld, but logs showed "Found 22 incomplete
Protractor shops to drain" and active chunking). Verify via the worker's Render logs, not
a lone Mongo lock read.

**Why Protractor still finishes slowly even with the drain on:** singleton drain (one
Protractor process at a time, by design, to spare shared Mongo + per-shop API) walking 22
shops × 5-year horizon. Plus some shops hit write errors that waste cycles — e.g. shop 141
(2026-06-07) threw E11000 dup-key on `normalized_work_orders` (the known WO dual-unique
race) AND Postgres `23503` FK violations on dependent `service_job` rows (parent WO write
failed first, so child FK fails). Those don't hard-crash the drain but can keep a shop from
completing cleanly.
