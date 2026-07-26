---
name: CARFAX empty-ok snapshot short TTL
description: Why ok:true CARFAX snapshots with zero serviceRecords appear and how the short-TTL guard works
---

An ok:true CARFAX Service History payload can legitimately parse to ZERO service
records (degraded/partial upstream response with empty `serviceHistory.displayRecords`,
or a genuinely history-less vehicle). `upsertCarfaxSnapshot`'s preservation guard only
protects VINs that already had good content — a FIRST-EVER fetch during degradation
falls through to the happy path and persists ok:true + empty, which previously counted
as fresh for the full 7-day TTL, silently removing the CARFAX tier of the mileage
waterfall (this is what hit the Lexus behind the stale-mileage incident: empty snapshot
persisted, healthy refetch 11 days later found 18 valid records).

**Rule:** empty-ok snapshots are stamped `lastEmptyFetchAt` on write and get a short
freshness window on read (`CARFAX_EMPTY_TTL_MS`, default 6h) in BOTH
`fetchCarfaxWithCache` and `fetchCarfaxStaleWhileRevalidate` (SWR refresh is
background/free-latency). Same pattern as plan-cache `oemMissing`.

**Why 6h not 30s:** CARFAX fetches are paid; only ~200 of 65k+ cached reports are
empty fleet-wide, so genuinely-empty vehicles cost at most one refetch per window.

**How to apply:** any new CARFAX read path must route freshness through the same
empty-aware check; never treat `ok:true` alone as "healthy data present" —
check `serviceRecords.length`.
