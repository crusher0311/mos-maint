---
name: Backfill rate-limit shrink + jobs-synced counter
description: Why throttled Tekmetric backfill chunks must shrink-and-retry (not skip), and why "0 jobs synced" can be a counter lie on bulk-migrated shops.
---

# Throttled chunks must shrink-and-retry, never FORCE_SKIP

**Rule:** A backfill chunk that fails *while it accumulated meaningful 429 backoff* is a
throttling failure, not a bad-data window. It must shrink its date span and retry the
SAME chunk end, and must NOT count toward the consecutive-error FORCE_SKIP threshold.

**Why:** FORCE_SKIP advances the cursor past the window without ingesting it → a
permanent history gap. Rate-limit failures are transient; skipping them loses data the
shop actually has. (Autolink / shopId 144 stalled at the same window since June 2026 on
repeated 429s, sitting at 2/3 consecutive errors — one more run would have gapped it.)

**How to apply:** Classify via the live 429-backoff accumulator
(`chunkBackoffCounter.ms`, already in scope at the advance decision), not by inspecting
error type. On a rate-limited error, shrink the span (halve down to a ~15-day floor),
keep the same chunk end, persist the smaller span as an override, and clear the override
once a chunk succeeds (auto-recovers to normal pace size). Set `lastError` null on the
throttled path so the shop isn't flagged red — but know the tradeoff: a shop can sit at
the floor span indefinitely under sustained throttling with no `lastError`; visibility
then depends on a frozen `lastCursorMoveAt` + `advanceMode=SHRINK` in chunk metrics.

# "0 jobs synced" is often a counter lie, not missing data

**Rule:** Tekmetric `tekmetric_backfill_progress.totalJobsIndexed` only counts jobs the
chunker itself committed ($inc). Bulk/migration-seeded jobs go straight into `job_index`
and never bump it, so migrated shops can show "0 jobs indexed" while having tens of
thousands of real rows.

**Why/how to apply:** Before believing a "0 synced" report, check actual `job_index`
(and PG `normalized_service_jobs`) counts for the shop. The platform-admin shops list
falls back to a `job_index` count *scoped to zero-counter shops only* — a fleet-wide
`job_index` $group was deliberately removed for perf because that endpoint loads ALL
shops. `job_index.shopId` is stored numeric for some shops, string for others; match
`{$in:[number,string]}` and merge buckets by `String(_id)`.
