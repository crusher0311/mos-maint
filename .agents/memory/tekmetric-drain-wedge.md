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
   (`app/api/cron/tekmetric-backfill/route.ts` ~lines 1494/1696 check `tekmetric_drain_lock.expiresAt`).
   So while a wedged drain holds the lease, the cron fallback no-ops (the ~77ms runs).

Net: a single hung HTTP request → permanent stall of all standard Tekmetric backfill until a Render
redeploy/OOM restarts the worker (which is why progress comes in bursts after deploys, then stalls).

**Contrast:** the full-page in-flight lock (`lib/integrations/tekmetric/inflight-lock.ts`) was already
fixed to be *progress-heartbeat* based (stealable when wedged). The global drain lease was NOT — same
class of bug, unfixed.

**Why:** the drain was built to bypass the cron's 300s ceiling for big shops; robustness against a
hung upstream request was never added.

**How to apply / fix direction (proposed, not yet implemented as of 2026-05-30):**
- Add a per-request timeout to the tekmetric fetch (combine `AbortSignal.timeout(ms)` with the
  existing operator signal via `AbortSignal.any`) so a hung request fails-and-retries instead of wedging.
- Make the drain lease refresh progress-aware (only refresh if a chunk completed recently) OR add a
  per-chunk watchdog that aborts a chunk exceeding N seconds — so a wedged drain self-releases and the
  cron resumes.
- Separately, the full-page cron (`/api/cron/tekmetric-fullpage-backfill`) times out every run because
  its 270s deadline is only checked *between* shops, not within a chunk; same time-boxing fix pattern
  as the protractor-sync resumable-sweep fix.
- Immediate mitigation (prod action, dev Mongo == prod): deleting the `tekmetric_drain_lock` doc makes
  the cron resume and signals the wedged worker to stop refreshing; restarting the Render worker clears
  the wedge outright. Both are operator actions — ask first.
