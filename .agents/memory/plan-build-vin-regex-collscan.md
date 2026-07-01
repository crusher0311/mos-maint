---
name: Plan-build VIN-regex COLLSCAN saturation
description: Case-insensitive $regex VIN lookups in plan-build defeat indexes → COLLSCAN → shared-Mongo saturation → fleet-wide sync-cron timeouts.
---

# Plan-build VIN-regex COLLSCAN → fleet-wide sync stall

Plan-build resolves the "current work order" for a VIN by querying the source
work-order collections. Some callsites match the VIN with a **case-insensitive
regex** — `vin: { $regex: new RegExp(`^${vin}$`, 'i') }`. The `i` flag makes the
query **non-indexable**, so on `tekmetric_work_orders` (~1.68M docs) and
`normalized_work_orders` (~2.5M docs) it degrades to a **COLLSCAN of 15–43s each**.

The dashboard prefetch loop fans plan-build out across dozens of vehicles ×
many shops concurrently, so these COLLSCANs pile up and **saturate the shared
Mongo cluster's IO/working-set** (connections are NOT the bottleneck — plenty
free, zero queue). That starves *every* in-process sync cron on the web service
— `protractor-sync`, `tekmetric-incremental-sync`, `protractor-stage-refresh` —
which then **time out at their full budget on every run**. Net effect: new
check-ins stop appearing on the dashboard **fleet-wide** (looks like one shop's
webhook broke, but it's global and provider-agnostic).

**The fix pattern:** match the VIN with **exact equality on the uppercased VIN**
(`vin: vin.toUpperCase()`), not a case-insensitive regex — VINs are stored
uppercased on write. `lib/plan-build/open-ro-mileage.ts` already does this
correctly (`vin: vinUpper` + `shopId: { $in: shopIdVariants }`) and is the
reference. Offenders use `{ $regex: /^VIN$/i }` on `tekmetric_work_orders`
(e.g. the plan page's parallel WO-source lookup, plus a sibling callsite that
`$or`s `tekmetricShopId` num/str with `shopId` num/str — the `tekmetricShopId`
branch has no index at all).

**Why:** a case-insensitive regex can never use a b-tree index; an anchored
case-*sensitive* regex can, but exact equality is simpler and index-optimal.

**How to apply:** when a plan-build / VHI / dashboard VIN lookup is slow or the
whole fleet's sync crons start timing out together, check `currentOp` for
COLLSCANs on `tekmetric_work_orders` / `normalized_work_orders` and grep for
`vin: { $regex` in plan-build paths. Diagnosis is Mongo saturation, not a broken
webhook and not connection exhaustion. Indexes alone don't help while the `i`
regex remains — the query has to change.

**tekmetric_work_orders shop key:** the canonical/indexed shop field is `shopId`
(index `{shopId, vin, completedDate}`). `tekmetricShopId` is ALSO stored but has
NO index. The Tekmetric webhook upserts by `{ workOrderId }` alone and only sets
`shopId` when the shops lookup succeeds, so ~275/1.68M rows are `shopId`-less
(webhooks that landed before the shop was connected; they self-heal on the next
webhook update). Query by `shopId: { $in: [String, Number] }` — do NOT add a
`tekmetricShopId` $or/fallback branch to "catch" those rows: it's unindexed and
reintroduces the COLLSCAN for a de-minimis, cosmetic (plan-cover name / RO#)
gain. Protractor is different: `protractor_work_orders` has NO vin index and
stores VINs as-is (mixed case), so its lookups legitimately keep a
case-insensitive match and are per-shop-scoped (not the fleet saturator).
