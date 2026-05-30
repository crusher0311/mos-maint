---
name: Tekmetric backfill drain wedge
description: Why Tekmetric backfills chronically stall (drain worker holds lease but makes no progress) and the root-cause fixes.
---

# Tekmetric backfill chronic stall — root cause

Symptom: most Tekmetric shops' backfills never complete / never run. `tekmetric_backfill_progress`
shows most shops' `lastRunAt` days old while a `backfill-drain-worker` (Render worker service) is alive.

Failure chain (all three must hold):
1. **No per-request timeout on the Tekmetric `fetch`** (`lib/integrations/tekmetric/client.ts`):
   the request only carries the operator's manual abort signal (SIGINT via `runWithTekmetricAbortSignal`),
   never an `AbortSignal.timeout`. Node `fetch`/undici has no short default, so one hung
   connection (open socket, no response) blocks that drain worker forever.
2. **The drain global lease is refreshed by a blind 60s timer** (`scripts/drain-tekmetric-backfill.ts`
   `lockRefresher` setInterval), independent of whether any chunk completed. So a fully-wedged drain
   keeps `tekmetric_drain_lock` alive indefinitely.
3. **The standard cron + boosts defer whenever the drain lease is live**
   (they check `tekmetric_drain_lock.expiresAt` before doing work). So while a wedged drain holds the
   lease, the cron fallback no-ops (you see suspiciously fast ~tens-of-ms cron runs).

Net: a single hung HTTP request → permanent stall of all standard Tekmetric backfill until a Render
redeploy/OOM restarts the worker (which is why progress comes in bursts after deploys, then stalls).

**Contrast:** the full-page in-flight lock (`lib/integrations/tekmetric/inflight-lock.ts`) was already
fixed to be *progress-heartbeat* based (stealable when wedged). The global drain lease was NOT — same
class of bug, unfixed.

**Why:** the drain was built to bypass the cron's 300s ceiling for big shops; robustness against a
hung upstream request was never added.

**Durable lessons (this class of bug recurs across the Tekmetric/Protractor sync layer):**
- Any long-lived background worker that issues `fetch` to a shop-management API MUST carry a
  per-request timeout. Node `fetch`/undici has no short default, so one hung socket blocks the worker
  forever. Combine `AbortSignal.timeout(ms)` with the operator/hard-cancel signal via `AbortSignal.any`,
  and treat a timeout as *retriable* (back off within the existing attempt budget) — distinct from an
  operator abort, which must rethrow immediately. The token fetch needs the same treatment, and the
  token call must sit *inside* the retry loop or a token timeout escapes it.
- Any distributed lease/lock held by a worker MUST be progress-aware, never refreshed on a blind timer:
  refresh only while real progress is happening, else a wedged holder starves every fallback. Measure
  progress at a granularity *finer than* the unit of work — here a single chunk is 50-100 pages and can
  run 40+ min, so the watchdog heartbeats per *page*; a chunk-granularity watchdog would false-positive
  and kill healthy work. (The full-page in-flight lock was already heartbeat/stealable; the global drain
  lease was the same bug, later fixed the same way.)
- Any route/cron with a wall-clock ceiling MUST thread its deadline *into* the work unit and check it at
  loop entry (before issuing the next page fetch), not only between shops — otherwise a late-started
  chunk does one more full cycle and overruns the hard kill.

**Immediate mitigation (prod action, dev Mongo == prod):** deleting the `tekmetric_drain_lock` doc makes
the cron resume and (because the refresher uses `updateOne` without upsert) signals the wedged worker to
stop refreshing; restarting the Render worker clears the wedge outright. Both are operator actions — ask
first.
