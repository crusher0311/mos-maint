---
name: Declined jobs as false maintenance anchors
description: Why declined/unauthorized jobs wrongly reset maintenance interval clocks, and the per-provider authorization signals that must gate "last done" anchors.
---

# Declined jobs must never anchor a maintenance interval

A "last done" anchor for a maintenance item must come ONLY from a genuinely
performed (authorized) job. A customer-declined line is not performed service —
if it anchors, the interval clock resets and the service wrongly shows
up-to-date.

**Why:** Confirmed bug — a declined spark-plug job on a Posted RO acted as the
spark-plug anchor and hid an overdue service.

**Per-provider authorization signals (they differ — don't assume one flag):**
- Tekmetric: explicit per-job `authorized` boolean. Historically NOT captured
  on `job_index` writes, so ALL Tekmetric jobs (incl. declined) looked
  performed. This was the gap.
- Protractor: declined = DeferredServicePackages, stamped `isDeferred: true`
  (already handled).
- Shop-Ware: declined services are not written to `job_index` at all; indexed
  rows carry `status` ("completed"/"open").

**How to apply:**
- Any new `job_index` reader that builds anchors must filter declined rows via
  `isDeclinedJobIndexRow()` in `lib/job-index.ts`.
- Live-WO loops that read `wo.data.jobs` must skip `job.authorized === false`
  even on terminal/posted ROs (the old "open RO only" filter missed these).
- Legacy `job_index` rows have NO `authorized` field — treat them as performed
  (conservative) so a half-migrated dataset never drops real history. Rows pick
  up the flag on re-index (content-hash includes `authorized`; or
  `reindexFromStoredData(shopId)`). Re-indexing prod is an operator action —
  dev Mongo IS prod Mongo here.
