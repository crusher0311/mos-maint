# Re-indexing declined jobs (Task #608)

## Background

Declined (customer-unauthorized) jobs were being written to `job_index` with no
authorization signal on the **Tekmetric** path, so the plan builder treated them
as performed service and used them as "last done" anchors — resetting the
maintenance interval clock. (Confirmed on International Auto, shopId 100, RO
#14489 Camry: a declined spark-plug job from Posted RO #14286 acted as the
anchor.)

Protractor already stamped `isDeferred: true` on declined service packages, and
Shop-Ware does not index declined services at all (its rows carry
`status: completed/open`). The gap was Tekmetric only.

## What the code change does

1. **Ingestion** — every Tekmetric `job_index` write now records
   `authorized: <boolean>` when the source job carries one (live indexer,
   `reindexFromStoredData`, incremental backfill, and full-page backfill).
2. **Readers** — `app/api/plan-build/route.ts` and
   `app/api/extension/plan/route.ts` skip declined rows via
   `isDeclinedJobIndexRow()` (Tekmetric `authorized === false`, Protractor
   `isDeferred === true`, Shop-Ware non-`completed` `status`) before building
   "last done" anchors.
3. **Legacy safety** — rows written before this change have **no** `authorized`
   field and are deliberately treated as *performed* so a half-migrated dataset
   never silently drops real service history. Only an **explicit** declined
   signal filters a row out.

Because the reader fix is live immediately, the bug stops the moment the code
deploys — even before any re-index — for any RO whose full WO doc still carries
`jobs[].authorized` (the live WO loop reads it directly). The job_index reader
filter only catches declines once the rows carry the flag (see below).

## Re-indexing existing rows (OPERATOR ACTION — do NOT run from dev)

> ⚠️ Dev Mongo **is** prod Mongo for this repl. Do not run any backfill,
> sync, or `reindexFromStoredData` from an isolated/dev environment. The steps
> below are for a deliberate operator action against production.

Existing `job_index` rows pick up the new `authorized` field automatically the
next time their shop is re-indexed. Two mechanisms exist:

- **Content-hash bump (automatic on next backfill).** `computeContentHash` in
  both `app/api/cron/tekmetric-backfill/route.ts` and
  `lib/integrations/tekmetric/full-page-backfill.ts` now includes `authorized`.
  Any existing row whose stored hash predates this change will differ and be
  rewritten on the next backfill pass for that shop — no extra step needed.

- **Targeted reindex from stored WO docs.** `reindexFromStoredData(shopId?)` in
  `lib/integrations/tekmetric/job-index.ts` rebuilds `job_index` from the
  already-stored `tekmetric_work_orders` docs (no upstream API calls). Use this
  to fast-fix a single shop (e.g. shopId 100) without waiting for a full
  backfill cycle.

Until a row is re-indexed, it has no `authorized` field and is treated as
performed (conservative). This is acceptable: the live WO loop already filters
declines for shops with full WO docs, and the worst case for a stale job_index
row is the pre-existing behavior, not a new regression.

## Verification

- Unit/triage regression: `npm run test:plan-build-task-608`
- Spot-check a shop after reindex: confirm declined jobs still appear in history
  context but no longer anchor the interval (the service stays due/overdue).
