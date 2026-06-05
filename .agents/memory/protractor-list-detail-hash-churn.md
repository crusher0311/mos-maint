---
name: Protractor list-vs-detail extraction parity
description: List and detail invoice extraction are content-identical but differ in line ORDER + float rounding, so the job fingerprint flips when switching extraction source.
---

# Protractor list vs detail: content-identical, fingerprint differs

A bounded read-only parity probe (shop 25, 90-day window, 25 invoices) compared
job entries extracted from the `/Invoice/?startDate&endDate` **list** row vs the
`/Invoice/{id}` **detail** payload (the path the Task #582 backfill speed-up
removed). Both paths run the same `extractJobIndexFromWorkOrder`.

**Finding:** the extracted job CONTENT is identical — same parts, labor,
descriptions, part numbers, quantities, unit/extended prices, vehicle, and total
— with a 1:1 entry count match on every invoice. But `computeJobHash` differs on
~60% of invoices because of two cosmetic causes:

1. **Line order differs.** The list returns `lines` in a different order than
   detail (e.g. list = `[part, labor]`, detail = `[labor, part]`). Same lines,
   reordered. `computeJobHash` hashes the `lines` array order-sensitively.
2. **Float rounding.** Occasional `totals.totalAmount` representation blips
   (`267.29999999999995` vs `267.3`).

(`metadata.indexedAt` also differs but is already excluded from the hash.)

**Why it matters:** the job_index change-detection keys off `computeJobHash`.
Switching extraction source (detail → list) flips the hash for already-indexed
jobs, so the first list-based pass makes every prior job look "changed" and
**re-writes it once** — a one-time wave of redundant Mongo/PG writes, not wrong
data. The float blip can also cause ongoing list-vs-detail-fallback hash
flip-flopping on a few records. Given the shared-Mongo write-overload incident,
that churn is worth avoiding.

**Fix options (decision pending, not yet done):**
- Make the fingerprint canonical: sort `lines` deterministically before hashing
  and round money to cents in `computeJobHash` (lib/job-index.ts). This makes
  list and detail produce identical hashes → no one-time churn, no flip-flop.
  **Caveat:** changing `computeJobHash` rehashes ALL providers' jobs once
  (global one-time churn), and affects Tekmetric too — treat as its own
  reviewed change, run off-peak.
- Or accept the one-time churn from the list-path switch and do nothing.

**How to apply:** before relying on the faster Protractor list path at scale (or
proposing the hash fix), remember the differences are cosmetic — do not chase
them as "missing data." The real lever is whether to canonicalize the hash.
