# Fleet sweep: line-less Protractor canned-job caches (2026-07-23)

Task #916 follow-up to the shop 219 incident (task #913): caches with titles
but zero lines on every item push $0 header-only packages.

## How to run

```bash
# Read-only report (safe any time):
npx tsx scripts/probe-lineless-canned-job-caches.ts

# Re-enrich affected shops (OFF-PEAK ONLY — saturates the shared
# Protractor rate limiter at ~300 req/min; a single 450-item shop
# already trips exponential backoff during business hours):
npx tsx scripts/probe-lineless-canned-job-caches.ts --fix

# Or fix specific shops:
npx tsx scripts/probe-lineless-canned-job-caches.ts --fix 219 222
```

Every write goes through the existing enrichment path
(`fetchCannedJobs` → `enrichCannedJobsWithDetails` → `upsertCannedJobsCache`)
and is skipped if `wouldDowngradeCannedJobsCache` says the new batch is
worse than the existing cache.

## Sweep result (2026-07-23, 34 cache docs scanned)

22 shops tripped `isCannedJobsCacheLineless` (0 items with lines in every
case). Shop 162 was re-enriched as validation (447/447 jobs written,
429 with lines — detector now clean for it). **21 shops remain**, pending
an off-peak `--fix` run:

| shopId | items | source | fetchedAt |
|---|---|---|---|
| 19 | 7475 | (none) | 2025-12-30 |
| 51 | 7510 | api | 2026-01-28 |
| 25 | 7482 | api | 2026-07-22 |
| 67 | 7472 | api | 2026-01-28 |
| 68 | 7536 | api | 2026-01-28 |
| 72 | 7469 | api | 2026-01-29 |
| 50 | 7477 | enriched | 2026-05-01 |
| 115 | 597 | (none) | 2026-05-02 |
| 109 | 866 | enriched | 2026-06-16 |
| 139 | 1579 | enriched | 2026-05-19 |
| 140 | 1495 | enriched | 2026-05-19 |
| 141 | 1498 | enriched | 2026-05-19 |
| 142 | 1499 | enriched | 2026-05-19 |
| 146 | 829 | enriched | 2026-05-20 |
| 148 | 829 | enriched | 2026-05-20 |
| 149 | 830 | enriched | 2026-05-20 |
| 150 | 839 | enriched | 2026-05-20 |
| 163 | 707 | enriched | 2026-05-30 |
| 222 | 1524 | enriched | 2026-07-11 |
| 227 | 643 | enriched | 2026-07-11 |
| 219 | 1513 | enriched | 2026-07-22 |

~~162 | 444 | enriched | 2026-05-30~~ — fixed 2026-07-23 (validation run).

## Fix run (2026-07-23, business hours — operator's explicit call)

Brandon approved running `--fix` mid-afternoon CT despite the off-peak
guidance. First attempt froze ~9 minutes in: a burst of upstream nginx 500s
hit all three in-flight detail calls, and the client's recursive retry
re-entered the shared `pLimit(3)` concurrency pool while each call still held
its slot — a permanent deadlock (log signature: 3 simultaneous "Server error
500, retrying..." lines, then silence with the process alive).

Fixed in `lib/integrations/protractor/client.ts`: retries are now a loop
inside the held concurrency slot (only the rate-limit slot is re-acquired per
attempt). The run was restarted and proceeded at ~250 details/min.

### Fix run results (completed 2026-07-23 ~22:30 UTC)

`--fix` over all 21 shops: **16 re-enriched, 5 failed** (script exit after
retries: `DONE: 16 re-enriched, 5 failed/skipped of 21 target(s)`).

| shopId | result |
|---|---|
| 51 | wrote 7508/7518, 7498 with lines |
| 25 | wrote 7482/7482, 7464 with lines |
| 67 | wrote 7477/7477, 7459 with lines |
| 68 | wrote 7542/7542, 7524 with lines |
| 72 | wrote 7474/7474, 7456 with lines |
| 50 | wrote 7478/7478, 7459 with lines |
| 115 | wrote 598/598, 516 with lines |
| 109 | wrote 865/865, 859 with lines |
| 139 | wrote 1588/1588, 1527 with lines |
| 140 | wrote 1504/1504, 1454 with lines |
| 141 | wrote 1491/1491, 1441 with lines |
| 142 | wrote 1507/1507, 1457 with lines |
| 163 | wrote 708/708, 588 with lines |
| 222 | wrote 1508/1508, 1455 with lines |
| 227 | wrote 1673/1673, 1562 with lines |
| 219 | wrote 1513/1513, 1461 with lines |
| 19 | FAILED — no `shops` doc exists for shopId 19; the cache row is an orphan from a deleted/disconnected shop. Candidate for deletion (operator call). |
| 146, 148, 149, 150 | FAILED — all four are "Total True Automotive" locations with stored Protractor creds that the API now rejects (`401 InvalidCredential` on every endpoint fallback). Needs fresh credentials from the shop; no cache write happened (old title-only caches remain, so pushes there still produce $0 packages until re-auth + re-run `--fix 146 148 149 150`). |

### Post-fix verification sweep

Re-ran the read-only sweep after the fix (34 docs scanned): **5 shops still
line-less — exactly the 5 failures above (19, 146, 148, 149, 150)**; all 16
re-enriched shops are clean. The six ~7.5k-item `api`/`(none)` lists turned
out to be fully enrichable (not raw dumps) — each now has >99.7% of items
with lines.

## Notes

- The six ~7.5k-item `api`/`(none)` shops are raw unenriched lists (many
  blank titles); expect long `--fix` runs and heavy filtering there.
  Total remaining ≈ 57k detail calls ≈ 3+ hours at the shared 300/min
  Protractor budget — run nights/weekends only.
- Shop 219 shows `enriched` from 2026-07-22 yet is still line-less, so its
  most recent enrichment write predates (or bypassed) the alt-shape line
  extractor; the 162 validation proves the current path restores lines.
