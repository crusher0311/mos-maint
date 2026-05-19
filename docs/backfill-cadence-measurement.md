# Backfill Cadence Measurement

Task #460. Goal: measure the ceiling on how tight the cron stagger can safely
go before host or downstream resource contention becomes the bottleneck — so
that any future cadence change is grounded in numbers, not guesswork.

> **Scope note.** This task only adds **measurement** plumbing. It does not
> change cadence numbers, re-architect the write path, or renegotiate
> provider rate limits.

## Method

Three instruments were wired into the existing backfill cron stack:

1. **Per-chunk metric writer** — `lib/backfill-metrics/chunk-metrics.ts`
   records one document per chunk into the new
   `backfill_chunk_metrics` Mongo collection (TTL ~30d) and also emits a
   single-line JSON `[BackfillChunkMetric] {...}` log so Better Stack can
   alert/graph without parsing free text. Each doc carries:
     - `provider` (`tekmetric` | `tekmetric-fullpage` | `protractor` | `shopware`)
     - `shopId`
     - `chunkStartedAt` / `chunkEndedAt` / `durationMs`
     - `pagesProcessed`, `rosProcessed`, `backoffMs`, `outcome`
     - `writes`: `mongoWrites`, `pgWrites`, `rateLimiterWaitsMs`,
       `rateLimiterTimeouts`, `rateLimiterFallbacks`, `retries`
     - free-form `extras` for per-provider signals (e.g. bulk-pre-pass counters)

   Write fan-out is captured via an `AsyncLocalStorage`-backed counter
   (`lib/backfill-metrics/write-counters.ts`) so concurrent chunks in the
   same process do not leak each other's numbers. The chunk wraps its body
   in `withChunkWriteCounters`; the normalized ingestion service and the
   shared Tekmetric rate limiter bump the counters in-band.

2. **Host load sampler** — `lib/backfill-metrics/host-load-sampler.ts`
   ticks every 30s and writes to the new `host_load_samples` Mongo
   collection (TTL ~30d):
     - process CPU% (delta `process.cpuUsage()` over the sample window, normalized to core count)
     - RSS, heap used/total, external
     - event-loop lag p50/p95/p99/max from `perf_hooks.monitorEventLoopDelay({resolution:20})`
     - Mongo `serverStatus.opcounters` + `connections.current/available`
     - PG `pg_stat_activity` aggregated by state (`active`, `idle in transaction`, `waiting*`)
   The sampler boots from `lib/cron/scheduler.cjs` whenever
   `ENABLE_INPROCESS_CRON=true`, so it shares the in-process cron's
   already-running web service and does not need its own worker.

3. **Co-fire stress trigger** — `lib/backfill-metrics/cofire-trigger.ts`
   plus admin endpoint `POST /api/admin/backfill-cofire`. Fires the
   Tekmetric, Protractor, and Shop-Ware cron routes in parallel so the
   peak combined load can be measured without waiting for the natural
   15-minute stagger to align. Two gates:
     - `BACKFILL_COFIRE_STRESS=true` env flag (the default opt-in for
       scheduled measurement windows)
     - request-body `{ override: true }` (the manual escape hatch — still
       requires platform-admin auth)
   Each provider hit is bounded by a 5-minute fetch timeout.

4. **Admin "Backfill Load" panel** — `/admin/backfill-load`, reading
   `GET /api/admin/backfill-load?windowMin=N`. Renders per-provider
   p50/p95/p99/max chunk duration, write fan-out percentiles, rate-limiter
   wait time, peak concurrent chunks across providers, and the most
   recent host-load sample + window aggregates. Auto-refreshes every 30s
   and exposes the co-fire trigger.

## What "ceiling" means here

The current cron stagger keeps Tekmetric, Protractor, and Shop-Ware
backfills ~15 minutes apart. The cadence ceiling is the closest stagger
where ALL of the following stay inside their existing safe operating
range under sustained co-fire load:

| Signal | Safe band | Source |
| --- | --- | --- |
| Chunk p95 wall-clock per provider | ≤ existing SLOW_P95_THRESHOLD_MS (10 min — `app/api/admin/sync-health/_shared.ts`) | Tekmetric task #48 baseline |
| Event-loop p99 lag | ≤ 200 ms | Render Node service responsiveness budget |
| PG `active` connections | ≤ 80% of pool max | Supabase pool exhaustion → cron 500s |
| Tekmetric rate-limiter fallbacks | 0 sustained | `shared-rate-limiter` falling open = blown 10 RPS cap |
| Backfill chunk error rate | ≤ baseline (currently <1%) | Existing alerting threshold |

The "named bottleneck" for any cadence proposal is whichever of those
five hits its limit first when the stagger tightens.

## Numbers

> **TBD — to be filled after the first measurement window.**
>
> The instrumentation shipped in task #460 starts collecting the moment
> the service redeploys. The recommended first window is one weekend of
> co-fire stress (set `BACKFILL_COFIRE_STRESS=true` Friday EOD, leave
> until Monday AM) plus one weekday business-hours window. Pull the
> numbers from `/admin/backfill-load?windowMin=4320` (3d) or query
> `backfill_chunk_metrics` / `host_load_samples` directly:
>
> ```js
> // p95 chunk duration per provider, last 24h
> db.backfill_chunk_metrics.aggregate([
>   { $match: { chunkEndedAt: { $gte: new Date(Date.now() - 24*3600*1000) } } },
>   { $group: { _id: "$provider", durations: { $push: "$durationMs" } } },
> ])
> ```
>
> Fill in these tables once the first window is captured:
>
> **Per-provider chunk performance (window: __, co-fire: __)**
>
> | Provider | Chunks | p50 dur | p95 dur | p99 dur | Backoff p95 | RL waits p95 | Mongo writes p95 | PG writes p95 |
> | --- | --- | --- | --- | --- | --- | --- | --- | --- |
> | tekmetric | | | | | | | | |
> | tekmetric-fullpage | | | | | | | | |
> | protractor | | | | | | | | |
> | shopware | | | | | | | | |
>
> **Host load under co-fire**
>
> | Signal | p50 | p95 | max |
> | --- | --- | --- | --- |
> | CPU% (process) | | | |
> | Event-loop p95 lag (ms) | | | |
> | RSS (MB) | | | |
> | PG active conns | | | |
> | Mongo opcounter delta/s | | | |
>
> **Named bottleneck**: ___ (chunk duration vs event-loop vs PG pool vs RL fallbacks vs error rate)
>
> **Recommended cadence**: ___ (stagger minutes, with margin)

## Best-practice notes for future cadence work

1. **Never tighten cadence without one full weekend of co-fire data.**
   Weekday business hours hide both the dense-RO weekend invoice push
   and the off-hours `getPaceConfig` chunkDays boost — both materially
   change chunk duration and write fan-out.

2. **Tighten one provider at a time.** If Tekmetric, Protractor, and
   Shop-Ware all move at once, the bottleneck attribution in the
   `backfill_chunk_metrics` rollup becomes ambiguous — you cannot tell
   which provider's tighter cadence pushed PG over the edge. Move one,
   measure for ≥3 days, repeat.

3. **Tekmetric shared-rate-limiter fallbacks are a hard stop.** Any
   non-zero `rateLimiterFallbacksTotal` in the admin panel means the
   limiter failed open and a 429 storm is possible. Roll back cadence
   before touching anything else.

4. **Keep the safety margin on PG `active` conns above the trial-cron
   spike.** The day-based-trial cron runs daily; if cadence is sized to
   the no-trial-tick baseline the trial-tick window can blow the pool.
   Always size to peak-including-trial.

5. **Measure write fan-out, not just RO count.** A 50-RO chunk that
   produces 800 line-item PG writes hurts the pool worse than a 200-RO
   chunk of mostly-status-change ROs with 40 writes. The `mongoWrites`
   / `pgWrites` percentiles in the admin panel are the signal — `roCount`
   alone undercounts the actual write pressure.

6. **The co-fire trigger is for measurement, not a recurring stress
   test.** Leaving `BACKFILL_COFIRE_STRESS=true` on permanently will
   keep the natural cron also firing — measurement windows should be
   bounded and the flag flipped back off.

7. **`host_load_samples` is per-process.** The web service running the
   in-process cron is what the sampler observes. If a future arch
   moves backfills to a dedicated worker the sampler needs to be started
   there too — the relevant load is whichever process is actually doing
   the chunking work.

## File map

| File | Role |
| --- | --- |
| `lib/backfill-metrics/chunk-metrics.ts` | Per-chunk metric writer + Better Stack log line |
| `lib/backfill-metrics/write-counters.ts` | AsyncLocalStorage write-fan-out counters |
| `lib/backfill-metrics/host-load-sampler.ts` | 30s host-load sampler (CPU/RSS/event-loop/Mongo/PG) |
| `lib/backfill-metrics/cofire-trigger.ts` | Tekmetric+Protractor+Shop-Ware co-fire helper |
| `app/api/admin/backfill-cofire/route.ts` | Admin POST to fire the co-fire stress |
| `app/api/admin/backfill-load/route.ts` | Admin GET that aggregates the two collections |
| `app/admin/backfill-load/page.tsx` | Admin "Backfill Load" panel |
| Modified: `lib/cron/scheduler.cjs` | Boots the host-load sampler at scheduler start |
| Modified: `lib/integrations/core/normalized-ingestion.ts` | Bumps `pgWrites` / `mongoWrites` counters |
| Modified: `lib/integrations/tekmetric/shared-rate-limiter.ts` | Bumps `rateLimiterWaitsMs` / `rateLimiterFallbacks` |
| Modified: `app/api/cron/tekmetric-backfill/route.ts` | Wraps chunk in counters + `recordChunkMetric` |
| Modified: `app/api/cron/protractor-backfill/route.ts` | Wraps chunk in counters + `recordChunkMetric` |
| Modified: `app/api/cron/shopware-backfill/route.ts` | Wraps chunk in counters + `recordChunkMetric` |
| Modified: `lib/integrations/tekmetric/full-page-backfill.ts` | Wraps chunk in counters + `recordChunkMetric` |
