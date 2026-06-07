---
name: Protractor backfill per-chunk normalize cost
description: Why dense Protractor backfill chunks take 15-20+ min and stall shops for days, despite healthy DBs
---

# Protractor backfill: the chunk-throughput bottleneck is serial per-WO normalize

A dense Protractor backfill chunk (e.g. shop 139 Telle Tire: a 60-day window =
~400 invoices / ~900 jobs) can take **15-20+ minutes to commit one chunk**, with
the cursor frozen the whole time and then jumping at the end. During that window:
- Mongo `currentOp` shows NO long op, `globalLock.currentQueue` all zeros.
- Supabase prod PG and the DataOne PG both show ~0 long-running queries.
- No errors, no timeout — looks like a hang but it is NOT a DB stall.

**Root cause:** the per-WO normalize is serial and heavy. The chunk fetch
(invoices) is fast; the cost is `ingestWorkOrderBatchWithAllEntities` looping each
WO through `ingestWorkOrderWithAllEntities` → WO upsert + service jobs + line items
+ payments + inspections + recommendations + dual-write to Supabase AND
`writeToJobIndex` (dualWriteToJobIndex defaults true) which itself calls the
**single-VIN** `enrichVinWithAces` (one DataOne round-trip) per WO. ~400 WOs ×
(several sequential PG writes + a DataOne lookup) = many minutes. A **bulk**
variant `enrichVinsWithAces` (one DataOne round-trip for many VINs) exists but is
NOT used on this path.

**Why this is the real "multi-day stall" cause:** a worker that picks a dense shop
spends 15-20 min per chunk; a 5-year horizon is dozens of chunks → hours/days per
shop. If the worker process is restarted (deploy) mid-grind, the chunk's
in-progress work is lost and it starts the same slow chunk again.

**Interaction with the round-robin + time-shrink drain change:** the round-robin
scheduler and the TIME-based `daysToProcess` shrink are correct and live, BUT
neither can preempt an in-flight `runProtractorBackfill` chunk (architect's
accepted caveat). The time-shrink only adapts the *next* chunk after the current
one finally records its `durationMs`, so the first slow chunk still runs full-size.

**Where the real fix lives (needs Brandon approval + push):** make chunk normalize
cheaper/parallel — e.g. pre-fetch ACES once per chunk via `enrichVinsWithAces`,
and/or skip the redundant per-WO `writeToJobIndex` dual-write (the Protractor sync
already does a single fast `job_index` bulkWrite for the chunk), and/or batch the
per-WO PG writes. Diagnosis only so far; no fix shipped.

**How to confirm next time:** if cursor is frozen but `touched=0` and all DBs are
idle/healthy, it's the serial normalize, not a wedge. Sampling the DataOne PG
`pg_stat_activity` intermittently catches a single fast decode query in flight.
