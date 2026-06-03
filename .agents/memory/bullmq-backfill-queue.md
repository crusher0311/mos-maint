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
