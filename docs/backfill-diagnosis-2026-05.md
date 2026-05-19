# Tekmetric Backfill Diagnosis — 2026-05-19

**Task:** #443 — READ-ONLY investigation. No code, schema, env, or cron changes were made.
**Run window:** Diagnostic scripts ran 2026-05-19 ~22:30–22:55 UTC against prod Mongo (`mos-maintenance-mvp.tiixipi.mongodb.net`) and prod Supabase PG.
**Raw evidence:** `.local/tasks/diagnose-backfill-evidence/` (diagnose-output.txt, diagnose-pt2-output.txt, probe-output.txt, per-shop-snapshot.json, count-divergence.json, api-usage-and-cron-runs.json, rate-buckets-sample.json, skipped-ros-error-signatures.json).
**Diagnostic scripts:** `scripts/diagnose-backfill-443.mjs`, `scripts/diagnose-backfill-443-pt2.mjs`, `scripts/probe-443.mjs`.

---

## TL;DR — Top three root causes

1. **The chunker cron barely runs on weekdays.** Only **11 of 62 incomplete shops had a `lastRunAt` in the last 24h**, all clustered around 4 distinct UTC hours. The weekend boost (`0,15,30,45 * * * 6,0`) and Monday catchup (`0,15,30,45 0-11 * * 1`) do not fire Tue–Fri, leaving the daily 01:00 UTC tick as effectively the only weekday backfill window. With `MAX_SHOPS_PER_RUN ≈ 15`, weekday throughput is ~15 shop-slots/day for 48+ chunker-eligible shops → each shop gets touched roughly every 3 days. This is the single largest contributor to the "stalled fleet-wide" perception.
2. **Full-page mode is jammed for the majority of the 14 queued shops.** 8 of 14 fullpage shops have `fullPageNextPage=0` / `totalPages=undefined` (never advanced a single page; some queued 9 days ago), 2 have `totalPages=0` with `nextPage>0` (corrupted state), 2 have stuck-in-flight locks that block reacquisition while no real progress is made, and only 2 are advancing normally.
3. **`consecutiveChunkErrors` does not reset on success, and `lastError` auto-clears after 6h.** 8 shops have `consecutiveChunkErrors ≥ 3` (max 18) but `lastError: null` / `lastErrorAt: null` — so the chunker continues "running" while the visibility into *why* the cursor isn't moving has been erased. The force-skip-bad-window safety net at `MAX_CONSECUTIVE_CHUNK_ERRORS = 3` either is not firing, or is firing silently and the error counter is then re-tripping immediately on the next window.

Additionally, **observability for both crons and Tekmetric API usage is silently broken** (Q2), which is why nobody noticed any of the above for ~9 days.

---

## Per-question findings

### Q1 — Per-shop snapshot of all 65 progress rows

Counts (see `per-shop-snapshot.json` for full per-shop data):

| Category | Shops |
|---|---|
| `completed: true` | 3 |
| Incomplete total | 62 |
| Running normally (recent `lastRunAt`, no high error counter, not in fullpage) | 38 |
| `consecutiveChunkErrors ≥ 3` with `lastError = null` | 8 |
| `fullPageMode: true` (incomplete) | 14 |
| Never-started (`lastRunAt` null, no fullpage) | 2 (`138` J&T, `144` Autolink — both onboarded 2026-05-19) |

The 8 stuck-on-errors shops: **32, 36, 37, 54, 57, 73, 74, 75** — historically the long-tail group; matches the comment at `route.ts:1522`. Their `consecutiveChunkErrors` range from 3 to 18.

### Q2 — Cron health (last 7d)

This question is the most important "negative" finding:

- **`cron_runs` collection does not exist in prod Mongo.** Only `extension_prefetch_locks`, `tekmetric_drain_lock`, and `tekmetric_backfill_progress` exist among lock/lease/cron-style collections. → The cron-health-alerter that queries `cron_runs` is reading an empty/missing collection and **has never paged**, despite real cron starvation.
- **`tekmetric_api_usage` collection has 0 documents (lifetime).** Per-shop Tekmetric API call tracking has been silently disabled or never wired. The admin "Tekmetric usage" view shows nothing real.
- **`api_usage_logs` (1,702 lifetime docs) recorded 0 Tekmetric calls and 22 total calls in the last 24h** — clearly not the path Tekmetric backfill uses, so it can neither confirm nor refute backfill traffic.
- **Indirect signal — `lastRunAt` clustering**: only 11 of 62 incomplete shops have a `lastRunAt` in the last 24h, and they cluster in 4 UTC hours: `00:00 (2 shops), 02:00 (3), 06:00 (5), 22:00 (1)`. There is **no evidence the every-15-min chunker is firing on weekdays**, which is consistent with the schedule in `lib/cron/jobs.cjs` (weekend boost = Sat/Sun only, Monday catchup = Mon morning only, daily tick = 01:00 UTC).
- **Stale `tekmetric_drain_lock` from 2026-05-10 22:28Z** — expired (no longer blocks), but indicates the last Sunday drain script (#428) was 9 days ago and either crashed or never started since. Harmless to current backfill but a sign that the global lease path is not being exercised either.

We cannot quantify chunks-per-run, 429-rate, or P50/P95 Tekmetric latency from Mongo because the storage for those metrics is empty. Better Stack would be needed for that, but the `lastRunAt` distribution alone is enough to conclude weekday cron firing is the bottleneck.

### Q3 — Per-RO exception (skipped-RO) state

**Per-RO exceptions are not the active root cause.** `recentSkippedRos` is empty fleet-wide; `lastRoSkipCount` is 0 on every shop; `consecutiveRoSkipRuns` is 0 on every shop. The archive collection is also empty. Whatever caused the skipped-RO storm has resolved.

### Q4 — Mongo ↔ PG count divergence

| Shop | progressTotal (Mongo `totalJobsIndexed`) | Mongo WOs | PG WOs | Mongo SJs | PG SJs | job_index |
|------|--:|--:|--:|--:|--:|--:|
| 32 | 438,911 | 18,406 | 18,406 | 12,559 | **11,090** | 285,375 |
| 36 | 248,071 | 17,113 | 17,112 | 20,210 | **19,269** | 178,765 |
| 37 | 338,927 | 18,401 | 18,401 | 20,947 | **14,139** | 233,450 |
| 54 | 102,852 | 16,847 | **16,762** | 14,807 | 14,796 | 216,291 |
| 82 |  36,549 |  9,983 |  9,983 | 18,870 | 18,870 | 346,237 |
| 99 |  25,322 | 10,233 | 10,232 |  8,310 |  8,310 | 158,833 |
| 118 |  6,462 |  2,815 |  2,815 |  7,961 |  7,961 |  54,970 |
| 138 |      0 |     66 |     66 |    276 |    276 |   1,376 |

Two distinct observations:

1. **`totalJobsIndexed` is not a work-order count** — it's a running `$inc` of `jobsIndexed` per chunk (probably summing service jobs touched or written per chunk including re-writes), so it inflates well past real WO totals. The admin UI labeling it as the headline "totalJobsIndexed" is misleading: the orange "Sarasota 110 / J&T 0 / Roundel 549" numbers in the task description are simply low because those shops have had few or zero chunker runs (the actual ROs are present once a run happens). **The data is not lost** — Mongo WO counts match the API for shops that have run.
2. **PG `normalized_service_jobs` lags Mongo on shops 32 (-12%), 36 (-5%), 37 (-33%)**. WO parity is essentially exact (off by ≤1 row from race-window writes). This is consistent with the FK-invariant issue captured in `replit.md` — some service jobs are still failing the parent FK invariant on those three shops, even after the skip-path backfill fix. Out of scope for this task (and not the cause of the "stuck" perception), but worth flagging as a follow-up.

### Q5 — Full-page mode (14 shops)

| Shop | `fullPageNextPage` | `totalPages` | `lastFullPageRunAt` | `queuedAt` | `inFlightUntil` | State |
|------|--:|--:|---|---|---|---|
| 82 | 31 | 1,345 | 2026-05-10 15:33 | 2026-05-07 | 2026-05-19 22:54 (active) | **Stuck**: in-flight lock keeps reacquiring but no real page progress since May 10 (9 days). |
| 122 | 37 | 2,702 | 2026-05-10 15:52 | 2026-05-07 | 2026-05-19 22:42 (active) | **Stuck**: same pattern as 82. |
| 118 | 34 | 469 | 2026-05-10 15:56 | 2026-05-07 | — | **Starved**: no lock, but not picked for 9 days by least-recently-run sort because never-started shops queue ahead. |
| 112 | 20 | **0** | 2026-05-18 18:11 | 2026-05-07 | — | **Corrupted state**: `totalPages=0` but `nextPage>0`. Recent runs do nothing because the loop condition is broken. |
| 123 | 24 | **0** | 2026-05-18 18:11 | 2026-05-07 | — | Same as 112. |
| 78, 88, 89, 92, 96, 100, 106, 129 | 0 | undefined | — | mix of 2026-05-10 → 2026-05-19 | **Never ran a first page** despite being queued (shop 88 has been waiting 9 days). |

The full-page GET cron is firing (lastFP ~yesterday for 112/123), but its per-tick budget and shop selection are stuck on a small subset; the bulk of the queued list never gets a turn. The 6-minute in-flight lock TTL is creating a flapping pattern on shops 82/122 — every cron tick either acquires the lock and is deadline-killed before writing a page, or is locked out by a runaway promise's lock.

### Q6 — Queue starvation for new shops

Recent onboards (last 14d):
`127, 128, 129, 130, 132, 133, 134, 135, 137, 138, 144, 145` (12 shops).

The 5-min `new-shop-backfill-fastpath` cron (`?fastpath=newShops`) is supposed to give these shops priority. Outcome:
- **138 (J&T)** and **144 (Autolink)** have no progress row beyond `queuedAt` — `lastRunAt = null`. Both were onboarded today (2026-05-19), so this could be normal latency, but both have been waiting hours.
- **135 (Technovia, onboarded 2026-05-18)** and **137 (Roundel, onboarded 2026-05-18)** have similar starved patterns per the snapshot — the orange "Roundel 549 jobs" really is one of those shops where the fastpath has produced a single early burst then nothing.

Combined with Q2 (no instrumentation), we cannot confirm whether the fastpath cron is firing at all in the in-process scheduler. The handler logic itself (`route.ts:1469-1504`) is correct (it filters `shops` by `createdAt >= now - 14d`). Either:
- The in-process scheduler is not invoking `/api/cron/tekmetric-backfill?fastpath=newShops` every 5 min (possible — `cron_runs` collection is empty, which is also where scheduler heartbeat would land if it wrote one), or
- It is firing but the chunker route is returning early for some other reason we can't see without logs.

### Q7 — `consecutiveChunkErrors` saturation

8 shops with `consecutiveChunkErrors ≥ 3`; max value seen is **18** (shop 37). For every one of them, `lastError` and `lastErrorAt` are `null`. Reading `route.ts:1340–1395`:

- Every chunk write updates `consecutiveChunkErrors: nextConsecutiveErrors` unconditionally.
- `lastError` / `lastErrorAt` are set to non-null **only** when `chunkHadError && !forceSkipBadWindow`, and cleared to `null` when neither condition holds.
- The error-auto-clear (~6h) hides the latest failure message while leaving the *counter* high.

The force-skip path (`forceSkipBadWindow = chunkHadError && nextConsecutiveErrors >= 3`) is supposed to advance the cursor past a bad window. The fact that the counter is at 18 on shop 37 means **either the force-skip is firing every chunk and immediately re-tripping on the next window, or the counter is not being reset on the rare successful chunks**. Without `chunkMetrics`/log evidence we can't disambiguate. Either way, these shops are in a doom loop: each rare run trips the error path, the cursor may advance one window, the counter never resets, and the latest concrete error message disappears 6h later.

### Q8 — Rate limiter

`tekmetric_rate_buckets` (last 10 buckets sampled):
- Every bucket is exactly **8/8 used** (`TEKMETRIC_SHARED_RPS_CAP=8`, hard ceiling 10).
- **Zero over-cap breaches** in the sample. The limiter is doing its job.
- No bucket gaps — the limiter is hit every second, suggesting any time a chunker tick *is* running, it saturates the per-second budget.

This is not the bottleneck. The chunker uses every drop when it runs; the problem is **how rarely it runs** (Q2/Q3 from the task spec).

---

## Other observations worth flagging

- **`tekmetric_drain_lock` is a stale `_id: global` doc from 2026-05-10 22:28Z.** Currently expired and therefore harmless, but it confirms no Sunday drain has run since May 10 (which aligns with shop-82/122/118 all going dark on May 10 — the drain script was presumably servicing them).
- **No "drain" worker process visible** in cron-firing patterns (would have shown a burst of `lastRunAt` updates on full-page shops).
- **`extension_prefetch_locks` exists** and was not investigated — out of scope for this task but flagged here so it's not confused with `tekmetric_drain_lock`.

---

## What this task did NOT change

Per task spec, no code, schema, env, or cron config was modified. The stale `tekmetric_drain_lock` doc, stuck `inFlightUntil` locks on shops 82/122, corrupted `totalPages=0` rows on shops 112/123, and high `consecutiveChunkErrors` counters were **not** reset.

The two diagnostic scripts (`scripts/diagnose-backfill-443.mjs`, `scripts/diagnose-backfill-443-pt2.mjs`, `scripts/probe-443.mjs`) are intentionally read-only and are safe to re-run.

---

## Recommended follow-up tasks (separate work items)

Listed in priority order. Each should be its own task; none should be bundled.

1. **Restore weekday backfill cadence.** Add a Tue–Fri schedule for the chunker (e.g. `0,15,30,45 * * * 2-5`) or expand the existing weekend boost. With 48+ chunker-eligible shops and `MAX_SHOPS_PER_RUN=15`, the current weekday throughput cannot keep up with new onboards.
2. **Fix `cron_runs` and `tekmetric_api_usage` instrumentation.** Either the scheduler should be writing to `cron_runs` (it isn't) or the alerter should be querying whatever collection it actually writes to. Without this, the next regression of this kind will also go unnoticed for 9+ days.
3. **Unjam full-page mode** — three sub-fixes: (a) reset stuck `inFlightUntil` on shops 82, 122 and add owner-side health-check so a re-acquired lock without page progress in N minutes is considered abandoned; (b) repair `totalPages=0` on shops 112, 123 (re-fetch page 1 and reset `nextPage=0` if needed); (c) ensure the GET cron actually picks the 8 fullpage shops with `lastFullPageRunAt=null` instead of starving them behind the same 3–4 shops.
4. **Reset `consecutiveChunkErrors` on any successful chunk** (or distinguish "force-skipped due to errors" from genuine success in the counter logic). Keep the latest non-null `lastError` for shops where the counter is ≥ 3, even past the 6h auto-clear, so we don't lose visibility.
5. **Investigate why the 5-min fastpath cron is not advancing brand-new shops** (138, 144, 145, 137, 135). Confirm the in-process scheduler is invoking `/api/cron/tekmetric-backfill?fastpath=newShops` with the query string preserved.
6. **PG service-jobs FK drift on shops 32 (-12%), 36 (-5%), 37 (-33%).** The skip-path backfill fix landed but those three shops still have meaningful Mongo→PG SJ shortfall. Worth a targeted re-ingestion.
7. **Rename or relabel `totalJobsIndexed`** in the admin UI — it's a chunk-write counter, not a WO count. The current label drove this task's framing ("Sarasota at 110, J&T at 0, etc."), and replacing the displayed value with `db.normalized_work_orders.countDocuments({shopId})` would make actual progress visible at a glance.
