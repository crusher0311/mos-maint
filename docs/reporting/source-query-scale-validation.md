# Reporting source-query scale validation

## Local result — not production rollout approval

The PostgreSQL source adapter preserves its existing C-collated text cursor,
exact payload bytes and digest semantics. It selects one narrow key in a
materialized CTE before serializing the full row, and uses separate first-page,
next-page and exact-key predicates without the nullable range OR.
Existing inventory checkpoints remain compatible.

The performance prerequisite is an index matching both shop equality and
`key::text COLLATE "C"`. Review candidates for all seven PostgreSQL channels are
in `scripts/reporting-projection/source-indexes.sql`. **None was installed in
production by this work.** The query change alone is not a proven production fix.
Do not deploy or resume population expecting the measured performance before
catalog/plan review and any separately approved index installation.

## Evidence

- Disposable PostgreSQL 17.6: 200,000 rows per source table, seven tables tested
  sequentially (1.4 million synthetic rows in total).
- Distribution per table: 180,000 neighboring-shop rows, 19,990 target-shop rows,
  ten sparse-shop rows; empty shops also tested.
- 56 real `PREPARE` / `EXPLAIN (ANALYZE, BUFFERS)` cases under
  `force_generic_plan`, including first, middle, end, exact and missing keys.
- All plans avoided Sort and Seq Scan. Maximum observed execution time was
  0.233 ms and maximum shared buffers touched was eight. These are warm local
  synthetic server timings, **not production latency or completion estimates**.
- Old/new queries returned identical cursor and serialized source bytes.
  Complete small mixed-case/non-ASCII traversal preserved ordering; source byte
  limits still return no oversized payload.
- PostgreSQL 16.10 scale tests also passed before the test was strengthened to
  use real prepared statements; the final prepared-plan test ran on 17.6.
- Existing reporting worker acceptance suite and workspace typecheck passed.
  The suite covers changed-source vetoes, crash/restart, expiry, holds and
  sustained feed traffic.

Run:

```sh
bash tests/run-reporting-source-scale.sh
bash tests/run-reporting-projection-worker.sh
npm run typecheck
```

The scale runner creates a disposable Unix-socket cluster with synthetic data
and a network-denial preload. It accepts no production connection string.
It installs candidate indexes only in that disposable database.

## Production prerequisite review

The approved read-only catalog/plan review has now completed. See
`source-index-production-preflight.md`: matching indexes are absent, four
sources are large, and free volume capacity remains unverified. No indexes
were installed or source queries executed during that check.

Before requesting index installation:

1. Read live index definitions, validity and source table sizes for every PG
   source, not just normalized work orders. Reuse genuinely equivalent indexes.
2. Confirm unique, non-null shop/key identity and inspect non-executing plans
   for first/next/exact queries. Duplicate selected keys fail closed in the
   adapter; they must not silently become an arbitrary raw copy.
3. Estimate disk and maintenance headroom. Prepare one-at-a-time concurrent
   index builds with statement timeout, independent health probes and native
   cancellation. CONCURRENTLY does not make a large build resource-free.
4. Obtain approval for the exact missing indexes; do not execute the candidate
   file wholesale or embed it in startup/deployment.
5. Verify valid matching indexes and indexed query plans before a separately
   bounded shop-227 population run. Keep reader activation separate.

## Limits not covered

Mongo source enumeration was not changed. Its mixed BSON-key ordering and
numeric/string shop identity handling remain intact. Mock-based functional
regressions pass, but this is **not** a real-Mongo source-query scale benchmark;
Mongo index/plan behavior still needs independent validation before claiming
end-to-end throughput. Feed-cursor correctness and source-query performance
are separate checks.

Serial one-document reads remain bounded but incur network round trips; this
change does not promise fast completion of a whole fleet inventory. Review,
freshness and unchanged verification requirements are not relaxed.
