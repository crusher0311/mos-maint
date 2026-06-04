---
name: BullMQ backfill queue (Tekmetric full-page)
description: Load-bearing invariants for the dormant Redis/BullMQ backfill queue — the footguns that kept the canary from ever flowing.
---

# BullMQ backfill queue invariants

The Tekmetric full-page (and prepass/drain) backfill can run via an in-process
cron path OR a BullMQ/Redis queue, gated per-shop by a feature flag. Turning the
queue on for a canary shop exposed several invariants that are easy to violate
and fail SILENTLY (the cron fails open to the inline path, so nothing errors —
the queue just never receives a job).

## Rules

- **Custom jobIds must not contain `:`** — BullMQ throws `Custom Ids cannot
  contain :` (it's Redis's key separator). Use `_` as the field delimiter
  (`tekmetric-fullpage_<shopId>`). A colon makes every enqueue throw, which
  `safeAdd` catches as `queue_unavailable` → cron falls back inline → the queue
  stays empty forever and it looks like the worker is idle.
- **Stable per-shop jobId ⇒ `removeOnComplete: true`** in DEFAULT_JOB_OPTS. These
  jobs are re-driven chunk-by-chunk (each chunk does up to MAX_PAGES_PER_RUN
  pages then returns `complete:false`). A lingering completed job with the same
  jobId dedupe-blocks the next cron enqueue. Keep `removeOnFail` falsey so
  failures survive for retry/inspection.
- **Continuation is the cron's job, not the processor's.** Re-enqueuing from
  inside the processor is a guaranteed no-op: the job is still `active`, so a
  same-jobId `add` is deduped. The cron's fast Pass-1 hand-off re-enqueues every
  flagged shop each tick; that's what advances chunks.
- **Queue processors must resolve their own Mongo handle.** `runFullPageBackfillChunk`
  dereferences `db.collection(...)` immediately. The cron threads a `getDb()`
  handle in; a processor that passes `null` crashes every job. Resolve `getDb()`
  per job (same as the prepass processor).
- **No double-processing:** the cron's Pass-1 enqueues queue-routed shops and
  `continue`s; only non-queue / queue-unavailable shops fall to the Pass-2 inline
  drain. Per-shop one-in-flight comes from the stable jobId (replaces the
  inflight-lock for queue-routed shops), so the processor omits `lockOwner`.

## Why
Each of these broke the canary without surfacing an error, because the whole
design fails OPEN to the in-process path on any queue trouble. "Worker idle / no
job events" is the symptom of all of them; check the web logs for the enqueue
error line first.

## How to apply
A Redis-free static guard (tests/queue-jobid-and-opts.smoke.ts, in test:smoke)
locks in: no `:` in producer jobIds, `removeOnComplete===true` & `removeOnFail`
falsey, and the fullpage processor resolves `getDb()` / never passes null.
Known still-latent (dormant, out of canary scope): the dead `processShops`
helper in the cron route still passes null-db, and the prepass/drain processors
keep the no-op self-re-enqueue — fix before enabling those queues.

## Canary soak finding — chunk duration runs unbounded under limiter starvation
Once the canary flowed, the queue worked end-to-end (jobs flow, complete, no
failures, no dedupe-block, page cursor advances each chunk). The real soak issue
is THROUGHPUT, not correctness: a single full-page chunk can stay `active` for
HOURS (observed 3.26h for one chunk vs 4.5min for a healthy one on the same shop).
**Why:** the chunk's soft deadline (SOFT_DEADLINE_MS=240s) is only checked at the
TOP of the per-PAGE while-loop, NOT inside the per-RO inner loop. Each page has up
to 100 ROs, and per-RO vehicle/customer/jobs lookups can hit the Tekmetric API.
Splitting the worker into its own Render service means worker (background priority,
effectiveCap≈5) and web (interactive, cap=8) now both pull on the SAME shared
cross-process rate limiter; under contention the limiter "fails closed" and each
API acquire waits ~5s + retries, so one page's 100 ROs can drag on far past 240s
with no deadline check until the page completes.
**Consequences:** (1) while a chunk is `active` for hours the cron's per-tick
re-enqueue is deduped (stable jobId) so the shop makes ZERO page progress that
whole time; (2) any chunk >15min crosses BullMQ stalledInterval
(STALLED_VISIBILITY_MS/2) — maxStalledCount=3 can re-run or eventually fail it.
**Implication for rollout:** do NOT widen from canary to fleet until chunk
duration is bounded (e.g. check the deadline inside the per-RO loop, or have the
worker pass a tight routeDeadlineMs). At fleet scale this would hold worker slots
for hours and saturate the limiter against interactive traffic.

**Fix landed (mid-page deadline bail):** the per-RO loop now checks the soft
deadline each iteration and, when hit, bails WITHOUT advancing the page cursor so
the page is re-fetched/finished next tick. Re-processing is safe: job_index
writes are content-hash idempotent (unchanged ROs don't re-increment
jobsIndexed), the partial normalized batch still flushes (idempotent upsert), and
the warmed vehicle/customer caches make the re-run cheaper so the page converges.
This bounds each chunk to ~SOFT_DEADLINE_MS + one in-flight call.
**Still open before FLEET (canary-OK without it):** per-RO Tekmetric calls
(/vehicles,/customers,/jobs) rely on the central helper's bounded ~5-retry cap
(~60s) — there's no explicit hard per-request abort timeout, so the deadline is
only enforced BETWEEN ROs, not inside a single hung await. Add a real
per-request timeout (and a deadlineHitMidPage frequency/streak metric) before
widening, so one stuck RO can't exceed budget and trip BullMQ stalled handling.

## Worker path has NO platform timeout backstop — a hung await wedges the shop forever
The single deadliest queue footgun, found right after the mid-page fix shipped:
the canary ran ONE clean chunk then went permanently silent — one worker pickup,
then NO completion / NO failure / NO stalled event for hours; worker alive but
idle (CPU ~1-2%, flat mem, single boot, no crash loop). The shop never ran again.
**Why:** the inline cron path is bounded for FREE by Render's `maxDuration=300`
request kill + the 6-min inflight-lock TTL, so a hung chunk self-heals. The
WORKER path has no such platform backstop. If any downstream `await` never
resolves (a Mongo/ingestion call to a service that accepts the connection but
never responds — the soft-deadline clock check can't interrupt a pending await),
the BullMQ job stays `active` forever: the worker's event loop is free, so it
keeps renewing the job lock → never stalls (so stalled-recovery never fires),
never fails (so `attempts:5` retry never fires — absence of retry/failed logs is
the tell it HUNG, didn't throw), never completes. And the stable per-shop jobId
dedupes every cron re-enqueue, with NO inline fallback → silent permanent wedge.
**Fix:** give the processor its own hard timeout (`Promise.race` vs 300s, mirroring
the inline envelope) so a hang becomes a job FAILURE → BullMQ retries → recovers;
chunk is resumable so a timeout loses ≤1 partial page. `clearTimeout` in `finally`.
**Caveats (follow-ups, not done):** `Promise.race` does NOT cancel the loser — the
hung promise keeps running in bg and may strand a Mongo connection / late-write
progress; real fix is AbortSignal/deadline cancellation into the downstream calls.
After 5 failed attempts the failed job dead-letters and its stable jobId dedupes
re-enqueues until an operator retries (by design = needs-human). Un-wedging the
CURRENT stuck job needs a worker restart (a redeploy does this) so the orphaned
`active` lock expires and stalled-recovery requeues it (~stalledInterval=15min).
**Also latent:** producer `safeAdd` can't detect duplicates in modern BullMQ —
`q.add` silently returns the existing job, so it reports `{enqueued:true}` even
when nothing was queued (masks exactly this wedge). Harden before fleet.
