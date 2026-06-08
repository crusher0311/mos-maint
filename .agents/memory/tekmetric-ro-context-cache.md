---
name: Tekmetric ro-context cache freshness & "incomplete row" slow path
description: Why keytag/oil-sticker loads go slow even when Tekmetric webhooks are flowing; plus the Mongo query gotchas that cause false "stale cache" diagnoses.
---

# Tekmetric keytag/sticker slowness is "incomplete cache rows", not stale cache

Keytag + oil sticker load via `GET /api/extension/ro-context`. For Tekmetric it
reads the legacy `tekmetric_work_orders` cache first, and falls back to the LIVE
Tekmetric API (getRepairOrder 6s + getVehicle/getCustomer 4s each) **whenever the
cached row is "incomplete"**, defined as missing ANY of:
`vin, customerName, vehicleYear, vehicleMake, vehicleModel`.

**Webhooks DO keep this cache fresh in real time.** Tekmetric webhooks are
configured per-shop on Tekmetric's side (we cannot self-register — the auto-subscribe
code is an unfinished scaffold; the subscribe endpoint "is owned by the partner team").
Many shops (incl. Endress shop 90 / tek 15807) get live RO Created/Updated/StatusChanged
webhooks that upsert straight into `tekmetric_work_orders`. So "cache is stale" is
usually WRONG — check completeness, not freshness.

**The real slow path:** rows where `vehicleYear/Make/Model` (or vin) are missing →
every load hits the live API. When backfill workers are running and saturating
Tekmetric, those live calls hit the 6s timeout → "keytags take forever." Suspend the
backfill workers and the same fallback gets fast again (sticker ~109ms). Snapshot
seen: Endress recent rows ~72% complete (fast), fleet ~88% complete.

**Enrichment gap (root cause of perpetually-incomplete rows):** the webhook handler
only enriches vehicle year/make/model when the row has NO vin yet
(`needsVehicle = !!vehicleId && !(existingWO?.vin)`). A row that already has a vin but
never got make/model is NEVER enriched → stays incomplete forever → always slow.
Durable fix = also enrich when year/make/model are missing (not only when vin missing),
and/or decode vin locally (DataOne) so completeness never depends on a live Tekmetric call.
Existing incomplete rows need a one-time enrichment pass; the handler fix only helps
rows touched by a future webhook.

## Mongo query gotchas (these caused a false "stale/empty cache" diagnosis)
- `shopId` is stored as a **STRING** ("90") on webhook-written rows (and as a number on
  some older rows) — `{shopId: 90}` misses the string rows. Query `tekmetricShopId`
  (number, e.g. 15807) or `shopId: {$in:[String(x),Number(x)]}` like ro-context does.
- RO number is field **`workOrderNumber`**, not `roNumber`. Doc `_id` key is
  `workOrderId` = the Tekmetric RO **id** (not the human RO number).
- Freshness = `updatedAt` (a real BSON Date, set every webhook). `updatedDate` is the
  Tekmetric ISO **string**; mixed string/Date types make naive sorts/`$gte` lie.
