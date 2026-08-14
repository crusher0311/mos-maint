# Fast triage — bug & slowness reports

Goal: answer most founder bug/slowness reports in **under a minute**, without
hand-written Mongo/PG queries.

> Everything on this page is **strictly read-only**. Remember: the dev
> environment's Mongo IS the production cluster — never run writes,
> `createIndex`, or flag flips from a triage session.

## What to ask for in a bug report

Collect these four things up front — they map 1:1 onto the tools below:

1. **Shop** (name or MOS shop id)
2. **RO# or VIN** (if the report is about a specific vehicle/repair order)
3. **Surface** (extension side panel, dashboard, partner API/AppFueled, admin)
4. **Timestamp** (when it happened, with timezone)

## Step 1 — Triage summary (this page, ~10 seconds)

The **Triage** panel at the top of Sync Health
(`/platform-admin/sync-health`) shows in one load:

- **Fleet real progress per provider** — heartbeat `lastChangedAt` moves only
  on real forward progress (cursor moves, counters climb), never on no-op
  ticks. Red = incomplete shops exist and nothing moved for 3h+.
- **Cron liveness** — per-provider "cron alive/quiet" from the scheduler's
  `lastSuccessByJob` (lives in the separate `mos` Mongo DB).
- **Queue depth per lane** — BullMQ waiting/active/failed (absent when Redis
  isn't configured in the environment).
- **Webhook deltas (24h)** — Protractor received vs processed (a growing
  unprocessed backlog older than 15 minutes = the silent processing-wedge
  pattern); Tekmetric and AutoFlow are received-only feeds.
- **Log feed freshness** — newest `production_logs.dt`. A frozen feed means
  we are blind in Better Stack history even while crons are green.
- **Recent alert states** — the durable state rows behind `[OPS-ALERT]`
  pages (pipeline stall, chunk speed, backfill/webhook health, perm-failed
  ROs).

## Step 2 — Is this shop healthy? (one command)

```bash
npx tsx scripts/diagnose-shop.ts <shopId>
```

Answers, in one printout:

- Provider detection (`integrationProvider`-first — nested `*.configured`
  alone false-reports connected shops).
- Backfill progress with the **correct per-provider completion fields**
  (Tekmetric progress-doc `complete`/`completed` can disagree — both are
  shown; Protractor uses the shops-doc flag; Shop-Ware progress lives in the
  historically named `ln` collection).
- Last **real** progress time (not `lastRunAt`, which bumps on no-ops).
- Webhook received-vs-processed delta for the shop.
- Provider RO cache freshness, `job_index` / normalized counts.
- Recent unresolved ingestion errors (Postgres).

## Step 3 — Trace one RO or VIN end-to-end (one command)

```bash
npx tsx scripts/trace-ro.ts <shopId> <roNumber|VIN>
```

Walks the chain — provider cache row → `job_index` → normalized stores →
plan cache — and prints a verdict of **where the chain broke**, e.g.:

- RO never arrived (webhook/backfill gap)
- Arrived but jobs never indexed (`jobsIndexed` gate / VIN-enrichment race)
- Indexed but plan cache stale/degraded (`oemMissing`, expired 4h TTL —
  note a deploy does **not** clear `cached_plans`)

A 17-character argument is treated as a VIN; anything else as the **display
RO#** (`workOrderNumber`, never the internal `workOrderId`).

## Step 4 — Slow/hung partner VHI calls

Partner/external VHI routes now emit structured lines for slow or hung
upstream work — search Better Stack (host `mos-maintenance-mvp-main`) for:

- `[SlowCall] slow_call_pending` — a call crossed its slow threshold and is
  still waiting (fires even if the request never completes, so a true hang
  always leaves evidence).
- `[SlowCall] slow_call_finished` / `slow_call_failed` — the same call
  settling, with total duration.
- `[PartnerVHI] rebuild_start` / `rebuild_done` — analyze-endpoint rebuild
  with duration; `rebuild_timeout_serving_stale` on the GET endpoint.
- `[upstream-timeout]` — a bounded call exceeded its budget and returned a
  fallback.

Filter by `requestId=` to follow one request end-to-end.

## Other legacy scripts

- `scripts/check-backfill-status.ts` — fleet-wide backfill/drain-lock
  snapshot (all shops, not one).
- `scripts/check-all-shops-progress.mjs` — Tekmetric per-shop cursor vs the
  2-year horizon goal.
