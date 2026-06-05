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

**Decision:** make `computeJobHash` canonical — sort line items into a stable
order and round money to cents before hashing — so the same job hashes
identically no matter which path extracted it. This kills the recurring
false-"changed" churn permanently rather than just accepting a one-time switch.
**Why:** the order/float differences are cosmetic, not data; an order-sensitive
hash turned them into endless redundant re-index writes, which matters under
shared-Mongo write pressure.

**Watch out when changing this hash:**
- It is SHARED by Protractor AND Shop-Ware. Tekmetric is NOT affected — it has
  its own separate content hash. AutoFlow/AutoVitals don't use this path.
- Any change re-fingerprints existing Protractor+Shop-Ware jobs once, gradually,
  as each is next scanned (sync cadence) — not a big-bang. Roll out off-peak and
  watch Mongo write load.
- Canonicalize by PRESERVING all line fields and only rounding money (don't
  whitelist) — optional identity fields (pcdbPartTypeId, partsTechPartId) must
  still affect the hash or genuine line updates get missed. Guard non-object
  line entries so malformed upstream payloads can't throw.

**How to apply:** before relying on the faster Protractor list path at scale (or
proposing the hash fix), remember the differences are cosmetic — do not chase
them as "missing data." The real lever is whether to canonicalize the hash.
