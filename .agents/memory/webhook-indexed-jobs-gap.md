---
name: Webhook received but jobs never indexed
description: Tekmetric ROs arrive via webhook but never reach job_index because the cache row has no VIN; plan/last-performed then falls back to CARFAX. Systemic (~9% fleet, ~26% at some shops).
---

# Webhook delivered the RO but jobs never got indexed

## Symptom
A vehicle's plan / "last performed" badge shows a service sourced **via CARFAX**
even though the shop did the work. Our own searchable history (Mongo `job_index`)
has **zero** rows for that VIN/RO at that shop, while the shop otherwise syncs fine.

## Confirmed mechanism (measured, not hypothetical)
- We DO receive the webhooks — `tekmetric_webhook_logs` has the full lifecycle
  (created → approved → completed → **posted**).
- The `tekmetric_work_orders` cache row exists and has `data.jobs` populated.
- **But the cache row has no `vin`.** The Tekmetric webhook payload (the RO lives
  **flat on `data`**, NOT `data.repairOrder`) carries `vehicleId`, **not `vin`**.
  VIN only lands via a separate deferred `getVehicle` enrichment, which is
  unreliable / often hasn't run.
- The terminal (Posted/Invoiced) indexing block is gated on
  `cached && !cached.jobsIndexed && cached.vin`. No VIN on the row → indexing is
  **silently skipped**, `jobsIndexed` never set, `job_index` stays empty.
- `job_index` is queried by `shopId + vehicle.vin`, so even if we indexed without a
  VIN it wouldn't be findable — the VIN must be *resolved*, not skipped.

## Blast radius (measured 2026-07, last 7 days)
- Fleet: **~391 of ~4,423 posted ROs (~8.8%)** missing from `job_index`.
- Worst shop (HEART Evanston, internal 32 / tek 469): **44 of 169 (~26%)**.
- Of shop 32's 44 missing: 43 had real jobs (1 genuinely empty); **42 of 44 had NO
  VIN** on the cache row (only 2 had a VIN). So no-VIN is the dominant cause.

## Why it went unnoticed
Webhook-health cron watches event *receipt* + latency, and pipeline-stall-alerter
watches fleet *progress* — neither checks per-RO indexing success. A skipped index
emits no error (soft `console.log` "skipping"), so there's no alert.

## Fix direction
1. Code (stop new gaps): in the terminal path of
   `app/api/webhooks/tekmetric/route.ts`, when `!cached.vin` but `vehicleId` exists,
   resolve VIN via `getVehicle(vehicleId)`, persist it to the cache row, THEN index.
   Only skip when VIN is truly unresolvable.
2. Recovery (existing gaps): re-index posted ROs that have `data.jobs` but aren't in
   `job_index`. NOTE: `reindexFromStoredData` is INSUFFICIENT — it also requires
   `wo.vin` (line ~552), so it skips the 42/44 no-VIN rows. Recovery must resolve VIN
   via `getVehicle` too. This is a **prod Mongo write** (dev==prod) → operator-gated.
3. Observability: alert when posted ROs don't get indexed within N minutes.

## Investigation gotchas
- Display "RO #" = `repairOrderNumber`; cache/job key = internal `repairOrder.id`
  (`tekmetric_work_orders.workOrderId = String(id)`). Looking up by the number
  returns null and looks like "never received."
- In `tekmetric_webhook_logs` the RO is **flat on `data`** (has `repairOrderNumber`,
  `jobs`, `shopId`), not `data.repairOrder`. Appointment events also live on `data`
  (distinguish by presence of `repairOrderNumber`).
- Collection (~700k docs) is indexed only on `{receivedAt:-1}`; use a tight window +
  in-memory nested filtering, else it times out. Full `tekmetric_work_orders` scans
  time out because each doc carries a large `data` blob.
