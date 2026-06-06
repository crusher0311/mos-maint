---
name: Tekmetric backfill queue lane is live but jobs hard-timeout
description: The BullMQ+Redis fast lane IS consuming; "stalled" queued shops are chunks dying at the 300s hard timeout, not a dormant/un-wired queue.
---

# Tekmetric backfill queue lane: live, but chunks hard-timeout

The BullMQ + Redis "fast lane" for Tekmetric full-page backfill **is wired and
actively consuming** in prod. Do NOT diagnose fleet stalls as "queue is dormant
/ Redis not provisioned." Worker logs show it picking up allowlisted shops and
running them.

**The real failure mode:** queued full-page jobs hit a **300s (5-min) hard
timeout** — `"chunk did not return (likely a hung downstream call)"` — and then
**exhaust all 5 BullMQ retries**, so the shop never advances. In the backfill
status tool these shops look "stalled," but they are being *served and failing*,
not waiting for a worker. Co-occurs with Tekmetric **"Rate limit budget
exhausted (waited 30000ms)"** errors — likely mechanism: too much concurrency
hammers the shared Tekmetric limiter → each call crawls → many sequential calls
overrun the 300s chunk budget → hard timeout → retry → same death.

**Why this matters:** the lever is NOT "turn on the queue" (it's on) and NOT
"add the giant to the allowlist." It's reduce downstream pressure (worker
concurrency vs the shared rate limiter) and/or add a bounded inner timeout so a
single hung call fails in seconds instead of burning the whole 5-min budget ×5.

**How to apply:** when shops won't complete, pull the worker service logs and
look for `hard timeout after 300000ms` + `Rate limit budget exhausted` BEFORE
assuming an infra/wiring problem.

## Prod topology gotchas (verified via Render API)
- Worker that consumes the queue: service **`mos-maint-background-v2`** (type
  background_worker), start `npm run worker` → `workers/worker.ts` (BullMQ
  consumer; exits clean and consumes NOTHING if it can't see `REDIS_URL`).
- Separate **`backfill-drain-worker`** service runs `npm run worker:backfill-drain`
  (the standalone non-queue drain) — this is what grinds non-allowlisted giants
  (e.g. the giant shop's slow pre-pass).
- `mos-tools` (web) holds `REDIS_URL` + `BACKFILL_QUEUE_SHOPS` and runs the cron
  enqueue pass.
- **Render `/v1/services/{id}/env-vars` does NOT return env-group / blueprint
  injected vars.** `REDIS_URL` showed absent on the worker via that endpoint yet
  is present at runtime (logs prove BullMQ connected). Don't conclude "Redis
  missing" from a service-level env-var listing — check the running logs.
- The dev repl shell has its own env; `REDIS_URL` unset there says nothing about
  prod.

## Dead-lettered queued shops do NOT self-heal (redeploy/restart won't re-drive them)
The fullpage queue is configured `removeOnFail: false`, so a job that exhausts its
5 retries persists in the BullMQ **failed set** keyed by its stable jobId
(`tekmetric-fullpage_<shopId>`). The cron re-drive re-`add`s with that SAME jobId,
which BullMQ treats as a no-op while the failed job still exists → **the shop is
silently never retried again.** Symptom: worker boots ("Started N BullMQ workers",
"Redis ready") then goes totally silent — no chunks — because every allowlisted
shop is sitting dead in the failed set and nothing new can enqueue. A code
deploy/worker restart does NOT clear this (failed jobs live in Redis, not process
memory).
**To re-drive:** use the built-in platform-admin action — POST
`/api/platform-admin/queues` `{action:"retry", queue, jobId}` →
`retryFailedJob` → `job.retry()` moves it failed→waiting. So after shipping a
throttle/concurrency fix, you must ALSO retry the already-dead jobs or the fix
can't be observed (worker has nothing to run).
**Evidence the throttle fix is correct:** pre-failure, shop 101's fullpage chunks
were completing in ~240–298s — right at the 300s cliff — then tipped into 300s
timeouts. Halving concurrency restores the missing headroom.
