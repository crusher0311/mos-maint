---
name: Shopmonkey API quirks
description: Non-obvious facts about the Shopmonkey v3 API and how the MOS integration was wired, learned during the SMS-provider parity build.
---

# Shopmonkey v3 integration

- **Base URL** `https://api.shopmonkey.cloud/v3`. Auth is a per-shop **API key sent as `Authorization: Bearer <key>`** — NOT OAuth. Validate via `GET /auth/api_key/status` → `{"valid":true}`. Orders list via `GET /order` (envelope `{data:[...]}`).

- **`locationId` is effectively optional.** Shopmonkey accounts frequently expose NO location_id at all. The API key alone authorizes all `/v3` requests. `locationId`/`companyId` are only used for matching an existing MOS shop in extension-shop-lookup and for the (default-OFF) webhook-subscribe — they are nullable everywhere in `getCredentials`.
  **How to apply:** never require a location/company id to consider Shopmonkey "configured"; key presence is sufficient. Don't block on a missing `SHOPMONKEY_LOCATION_ID`.

- **Amounts are in CENTS** (e.g. order field `appliedDiscountCents`). Confirmed against live `/order` data. Mirror Tekmetric's cents handling; do not divide/treat as dollars. The order grand total is `totalCostCents` (there is NO top-level `totalCents`); balance due is `remainingCostCents`.

- **Line items are NOT embedded on an order — fetch `/service_item` separately.** The `/order` LIST endpoint embeds vehicle + customer ONLY when you pass an `include` *object* via bracket notation (`include[vehicle]=true&include[customer]=true`); `include=`/`expand=` do NOT work. But `include[serviceItems]` is ignored — labor/parts/tire/fee lines live on a flat `/service_item` endpoint that REQUIRES a `vehicleId` or `customerId` filter (no unfiltered bulk list), and each item carries `order.id` for grouping. There is no service/job grouping under a Shopmonkey order, so the normalized path synthesizes ONE service job per order from the order-level cent totals and collapses all `/service_item` lines into it.
  **Why:** the read adapter (getWorkOrder(s)) and the ingestion sync paths (runBackfill/runIncrementalSync via `attachServiceItems`) must both fetch `/service_item` and attach it as `order.serviceItems` — relying on embedded `services[].labors/parts` yields zero line items on live data.
  **How to apply:** any new Shopmonkey read/ingest path must fetch `/service_item` for the order's vehicle/customer and filter by `order.id`; don't expect lines inside the order payload.

- **Single-host SPA** at `app.shopmonkey.cloud`. Unlike Shop-Ware/AutoFlow (tenant subdomain), there is no per-shop hostname, so the extension content adapter must discover companyId/locationId from the page rather than the hostname.

- **companyId/locationId live in the LaunchDarkly context (verified on a live session).** They are NOT in URL params, not in their own localStorage keys, and not in the auth JWT. Shopmonkey stores a LaunchDarkly multi-context as base64-JSON **inside the localStorage KEY name**: `ld:<envId>:<base64>` decodes to `{ company:{key,name}, location:{key,name}, user:{...}, kind:"multi" }`. `company.key` / `location.key` are 24-hex Mongo ObjectIds (a single-location shop has both equal). A sibling `ld:<envId>:$diagnostics` key exists — skip suffixes that aren't valid base64 JSON.
  **How to apply:** decode the `ld:` context as the primary id source. The old generic "key contains company+id" scan FALSE-POSITIVES on `algoliaCompanySearchAppIdKey` (value like `"C6099O1RSQ"`); any fallback scan must require an ObjectId/UUID-shaped value and skip algolia/pendo/canny keys. Order route is `/order/{uuid}` (singular); vehicle year/make/model extraction from page text works; VIN/mileage may legitimately be absent (e.g. marine/boat ROs).

- **No MOS shop is registered with a `shopmonkey` field yet (prod, as of 2026-06-05).** `shops` collection has zero docs with `shopmonkey.*`. So even with correct on-page id detection, `/api/extension/ro-context` can't resolve a MOS shop and the VHI Coach shows no real data until an operator onboards the shop (sets `shopmonkey.companyId`/`locationId` + apiKey on the shop doc). Adapter-side detection is confirmed; the remaining gap is shop onboarding, an operator/prod-data action.

- **Prod-safety:** dev Mongo == prod, so this build is dormant by design — no shops configured, backfills gated behind `SHOPMONKEY_BACKFILL_ENABLED`, webhook auto-subscribe behind `SHOPMONKEY_WEBHOOK_AUTO_SUBSCRIBE`, both default OFF. The new Mongo-touching files were added to the `scripts/check-direct-db.cjs` allowlist (that guard gates the Render prod build).

## Cloudflare 1015 pacing
api.shopmonkey.cloud sits behind a Cloudflare edge that trips error 1015 (a 429 with NO Retry-After header) well below the documented 5 RPS/300-min budget under sustained backfill load.
**Why:** the configured budget alone doesn't prevent 429 storms; the edge tolerance is the real ceiling.
**How to apply:** effective defaults are 2 RPS / 120-min (shared-rate-limiter + api-usage-tracker); every 429 sets a shared per-shop cooldown (`shopmonkey_rate_cooldowns`, extend-never-shorten, 5-min cap) honored by all processes before any request; retries are bounded+jittered. Raise via SHOPMONKEY_SHARED_RPS_CAP only if the edge tolerance is proven higher.
