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

## Fix (implemented)
1. Code (stop new gaps): terminal path of `app/api/webhooks/tekmetric/route.ts`
   now gates on `!cached.jobsIndexed` (not `cached.vin`); when vin missing but
   `vehicleId` exists it resolves vin via `getVehicle`, persists it, THEN indexes.
   Leaves `jobsIndexed` unset (retryable) only when vin is truly unresolvable.
   Needs a prod deploy (push to GitHub main → Render auto-deploy) to take effect.
2. Recovery (existing gaps): `scripts/reindex-missing-tekmetric-jobs.ts`
   (`--shop=N --days=D [--apply]`). Detects misses via a **server-side aggregation**
   over `tekmetric_webhook_logs` posted events (do NOT stream the window client-side
   — it times out) diffed against `job_index`, then per-RO resolves vin (cache or
   `getVehicle`) and calls `indexTekmetricWorkOrderJobs({preloadedJobs})`. Idempotent
   (upsert on shopId+workOrderId+servicePackageId). `reindexFromStoredData` is
   INSUFFICIENT — it requires `wo.vin` so it skips the dominant no-vin rows.
   This is a **prod Mongo write** (dev==prod) → operator-gated. Fleet recovery run
   (8-day window): 177 ROs / 759 jobs re-filed (shop 32 = 38/188 incl Gloria's RO;
   rest of fleet = 139/571). ~205 rows were "no resolvable VIN" — a data-quality
   exception (vehicle has no vin in Tekmetric), NOT an indexing failure; the deployed
   code fix leaves those `jobsIndexed` unset so they self-heal if a vin later appears.
   Don't retry no-vin rows forever. Fleet mode: `--detect-all` writes a miss-list
   file, then `--from-file --offset --limit --apply` in resumable batches (~80/batch
   fits a 120s window; run sequentially to avoid Tekmetric rate-limit + Mongo load).
3. Observability (not yet built): alert when posted ROs stay `!jobsIndexed` after N min.

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
