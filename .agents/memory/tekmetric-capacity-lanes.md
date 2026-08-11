---
name: Tekmetric capacity lanes
description: How Tekmetric background traffic is isolated from advisor-facing traffic — second API key + worker-owned incremental sync — and the invariants that keep the isolation real.
---

Two env-gated levers isolate Tekmetric background sync from user-facing traffic:

1. **Dedicated background credential** (`TEKMETRIC_BG_CLIENT_ID`/`TEKMETRIC_BG_CLIENT_SECRET`): background-priority requests authenticate on the second key. **Invariant: every rate-limiting layer must be keyed per credential lane** — local pacer queue, shared per-second buckets (`tekbg` prefix, zero interactive reserve), AND the distributed per-minute buckets + circuit breaker. A lane that shares any one layer with the primary key falsely contends and defeats the isolation (a review caught exactly this on the minute limiter). The background token is cached in-memory only; the persisted token doc stays primary-only. Envs unset = old single-key behavior.

2. **Worker-owned incremental sync** (`TEKMETRIC_INCREMENTAL_ON_WORKER=true`): **Invariant: the flag must suppress every web invocation path** — scheduler registration, the daily-all aggregator, and the route itself (legacy scripts and manual curls hit the route directly) — and the replacement loop must run in the process that is actually deployed (the backfill drain worker service), not just an optional entrypoint. Smoke tests in the prebuild pin both the lane keys and the entrypoint start.

**Why:** repeated business-hour slowdowns traced to background sync contending with advisors for the one 10 RPS key on the web instance.

**How to apply (operator-gated, never from dev):** provision the second key with Brandon; set the BG envs on every service making Tekmetric calls; before flipping the worker flag, give the worker a daytime power-schedule exception (workers auto-suspend weekday daytime — without it incremental sync stops during business hours). Fullpage backfill already has a worker lane via the BullMQ queue routing. The incremental completion log now prints negative-cache hits + rate — watch it to confirm retry storms stay gone.
