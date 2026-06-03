# Backfill Worker Queue — Cutover & Rollback Runbook

Task #513. Read this before flipping any of the queue feature flags in
production.

## What this changes

The Tekmetric full-page backfill, the jobs/vehicles/customers
pre-passes, and the Tekmetric + Protractor drain workers can now run
on a **dedicated worker service** backed by **BullMQ + Redis**, instead
of inside the main web service via `node-cron` ticks.

When the feature flag is off (default), every workload continues to
run exactly as it does today on the in-process scheduler. The new code
is dormant until an operator opts in.

## Prerequisites before flipping the flag

1. **Provision Redis on Render.**
   - Render → Dashboard → New → Redis. Pick a region matching the web
     service. Starter plan is sufficient for the load profile (~few
     hundred jobs/min steady state).
   - Copy the internal Redis URL.

2. **Set `REDIS_URL` on the web service.**
   - With this set, the producer code (`lib/queue/producer.ts`) is
     wired to BullMQ, but the per-shop flag is still off — no shop is
     routed to the queue yet. The presence of `REDIS_URL` is what
     `/admin/queues` uses to decide whether to render the dashboard.

3. **Deploy the worker service on Render.**
   - New → Background Worker (or new Web Service running `npm run worker`).
   - Start command: `npx tsx workers/worker.ts`
   - Environment: same `REDIS_URL` plus every env var the existing
     backfill needs (Tekmetric, Mongo, Postgres, Drizzle URLs, etc.).
   - Verify the boot log shows `[Worker] Started 4 BullMQ workers`.

4. **Run the readiness check (go/no-go).**
   - This is the single pre-cutover gate. It verifies Redis is reachable,
     that workers are actually consuming each queue, and prints what the
     flags would do right now — so go/no-go is unambiguous *before* any
     shop is routed.
   - CLI (on the web service, with prod env): `npm run queue:readiness`.
     Exit code 0 = ready, 1 = not ready (blockers are printed).
   - Or in a browser as a platform admin: open `/admin/queues` (the
     readiness panel is at the top) or hit
     `GET /api/admin/queues/readiness` for the raw JSON.
   - **Do not proceed past a NOT READY verdict.** Common blockers:
     `REDIS_URL` not set, Redis unreachable (firewall/region mismatch),
     or a queue with 0 consumers (worker service not deployed/started).
   - The readiness check is read-only — it never enqueues or mutates.

5. **Smoke-test on one canary shop.**
   - Pick a shop that's already complete or near-complete (low blast
     radius).
   - Set `BACKFILL_QUEUE_SHOPS=<canary-shop-id>` on the web service.
   - Re-run `npm run queue:readiness` and confirm the flag report shows
     that shop's decision as `→ queue (per_shop_allow)` and every other
     shop as `→ legacy`.
   - Trigger the cron tick OR POST to `/api/cron/tekmetric-fullpage-backfill`.
   - Confirm the response shows `routedTo: "queue"` for the canary shop
     (the per-shop result object also carries `jobId` on a fresh enqueue
     or `duplicate: true` if one was already in flight).
   - Watch `/admin/queues` for the job moving waiting → active → completed.
   - **Parity check** — both paths write the SAME
     `tekmetric_backfill_progress` fields, so a queued shop must advance
     exactly like a legacy one. Diff the row against expectations:
     `fullPageNextPage` should advance, `lastFullPageRunAt` should
     update, and `prePassNextPage` should advance for the pre-pass jobs.
     `/api/cron/catchup-status` surfaces these same fields plus a
     `queue.snapshots` block, so a single GET shows both the cursor
     movement and the queue depth.

## Cutover sequence

1. **Canary one shop** (above). Let it soak for at least 24h.
2. **Widen to 5 shops** via `BACKFILL_QUEUE_SHOPS=<ids>`. Soak 48h.
3. **Widen to 10 shops covering each backfill phase** (fresh shop,
   mid-backfill shop, near-complete shop, shop with a known stuck
   history). Soak through a weekend.
4. **Fleet-wide** — set `BACKFILL_QUEUE_ENABLED=true` and remove
   `BACKFILL_QUEUE_SHOPS`. Watch the failed-job list on
   `/admin/queues` for 24h.
5. **After two clean weeks**, file a follow-up task to delete the
   in-process backfill code paths.

## Rollback

If anything goes wrong at any stage:

```
BACKFILL_QUEUE_DISABLED=true
```

…on the web service. This wins over every other flag and immediately
routes every shop back to the in-process cron path. The worker service
can keep running; it will just stop receiving new jobs because the web
service stops enqueueing.

The in-flight-lock-based concurrency control (`inflight-lock.ts`) is
intentionally preserved in the in-process path so a rollback restores
identical pre-task-513 behavior with no further intervention.

## What does NOT change

- The Tekmetric **shared rate limiter** (`shared-rate-limiter.ts`)
  still gates every API call. The queue calls into it; throughput
  ceiling is still 8 RPS combined across processes.
- The `tekmetric_backfill_progress` doc remains the source of truth
  for per-shop cursor state. Both code paths read/write the same
  fields.
- The light periodic crons (token refresh, daily summaries, webhook
  health) stay on the in-process scheduler — out of scope for this
  task.

## Operating the queue

- **Dashboard:** `/admin/queues` (platform-admin only). Shows counts
  per queue (waiting / active / delayed / failed / completed / paused)
  and the failed-job sample.
- **Readiness check:** `npm run queue:readiness` (CLI) or
  `GET /api/admin/queues/readiness` (platform-admin JSON). The readiness
  panel is also rendered at the top of `/admin/queues`.
- **Catchup status:** `/api/cron/catchup-status` now includes a
  `queue.snapshots` block when the queue is enabled.
- **Retry a failed job:** on `/admin/queues`, each failed job has a
  **Retry** button that re-enqueues it (`POST /api/admin/queues` with
  `{ action: "retry", queue, jobId }`). The job keeps its original jobId,
  so a retry can't fan out into per-shop duplicates. No script needed.

## Known gaps left for follow-ups

- BullBoard UI is not mounted (uses our JSON+React admin page instead).

> Resolved (task #567): the pre-cutover readiness check
> (`npm run queue:readiness` / `GET /api/admin/queues/readiness`) and the
> retry-from-failed action on `/admin/queues` are now in place. The
> dashboard page itself (`app/admin/queues/page.tsx`) is now wired —
> previously only the JSON route existed.

> Resolved (task #523): the drain-protractor processor no longer spawns
> the legacy script as a child process. `scripts/drain-protractor-backfill.ts`
> now exports `drainProtractorShopChunk` / `loadIncompleteProtractorShops`,
> which the processor calls in-process (matching drain-tekmetric). The
> script still runs as a CLI for the legacy Render Background Worker.
