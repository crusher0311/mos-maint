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
Protractor process at a time, by design, to spare shared Mongo + per-shop API) walking the
backlog × 5-year horizon. The drain script re-scans ALL incomplete shops every ~25 min
(`loadIncompleteProtractorShops` selects by `protractor.connectionId` exists — ~44 shops,
WIDER than the ~29 `protractor.configured:true` set — and sorts OLDEST-cursor-first), then
spawns/exits and repeats.

**Stuck-shop signature (write errors are a SYMPTOM, not the cause).** A few big, oldest-data
shops (e.g. 141 cursor stuck at 2022-06-29, 109) get worked first EVERY cycle yet their
`backfill_progress.currentChunkEnd` never advances (lastRunAt can read days stale even while
the drain is actively writing their WOs right now). The tell: they throw E11000 dup-key on
`normalized_work_orders` + Postgres `23503` FK on `service_job` — because they are
**re-ingesting the same date range's work orders they already stored** (cursor didn't move,
so same invoices re-fetched and re-written). Strong hypothesis: a giant shop's chunk can't
fetch-AND-commit within the ~25-min run window before the script respawns, so it restarts the
same chunk forever = head-of-line stall that also starves newer shops behind it.

Completion gate is `isComplete = !chunkHadError && !hitPageCap && nextChunkEnd <= oldestDate`
(`lib/integrations/protractor/sync.ts`). `chunkHadError` is set ONLY by a fetch failure
(L343/513/518) — the normalized-ingestion writes are in their own try/catch (L621-623) and
the dup-key/FK failures are caught "non-fatal" deeper still, so they do NOT set chunkHadError
and do NOT by themselves block completion. The blocker is the cursor never advancing, not the
write errors.

Levers (all prod/operator-gated — confirm with Brandon): shrink horizon for stuck giants,
smaller chunk size so a chunk commits within the run window, fix oldest-first ordering so
giants don't starve the rest, narrow the selection to actually-configured shops.
