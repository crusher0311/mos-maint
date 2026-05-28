# Backfill Worker Service

Standalone Node process that consumes the BullMQ queues defined in
`lib/queue/queues.ts`. Designed to run as a **separate Render service**
(or `npm run worker` locally) so backfill load is fully isolated from
the web tier — see task #513.

## What runs here

| Queue | Processor | Notes |
| --- | --- | --- |
| `tekmetric-fullpage` | `processors/tekmetric-fullpage.ts` | wraps `runFullPageBackfillChunk` |
| `tekmetric-prepass` | `processors/tekmetric-prepass.ts` | jobs / vehicles / customers variants |
| `drain-tekmetric` | `processors/drain-tekmetric.ts` | wraps the existing drain script logic |
| `drain-protractor` | `processors/drain-protractor.ts` | wraps the existing drain script logic |

Concurrency is set per-queue inside `worker.ts`. Per-shop uniqueness
comes from BullMQ's `jobId` (set in `lib/queue/producer.ts`).

## Running

```
REDIS_URL=redis://... npm run worker
```

The worker is a no-op if `REDIS_URL` is unset.

## Failure handling

- Retries: exponential backoff, 5 attempts. See `DEFAULT_JOB_OPTS` in
  `lib/queue/queues.ts`.
- After all retries, the job lands in the `failed` set permanently.
  Operators see it on the admin sync-health page (`/admin/queues`).
- Stalled jobs (worker crashed mid-chunk) are re-queued after
  `STALLED_VISIBILITY_MS` (30 min).

## Rollback

Set `BACKFILL_QUEUE_DISABLED=true` on the web service to immediately
route every shop back to the in-process cron path. The worker can keep
running — it just won't receive new jobs once producers stop enqueuing.

See `docs/runbooks/worker-queue-cutover.md` for the full runbook.
