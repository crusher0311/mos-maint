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

## Notes

- The six ~7.5k-item `api`/`(none)` shops are raw unenriched lists (many
  blank titles); expect long `--fix` runs and heavy filtering there.
  Total remaining ≈ 57k detail calls ≈ 3+ hours at the shared 300/min
  Protractor budget — run nights/weekends only.
- Shop 219 shows `enriched` from 2026-07-22 yet is still line-less, so its
  most recent enrichment write predates (or bypassed) the alt-shape line
  extractor; the 162 validation proves the current path restores lines.
