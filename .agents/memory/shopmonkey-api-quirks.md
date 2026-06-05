---
name: Shopmonkey API quirks
description: Non-obvious facts about the Shopmonkey v3 API and how the MOS integration was wired, learned during the SMS-provider parity build.
---

# Shopmonkey v3 integration

- **Base URL** `https://api.shopmonkey.cloud/v3`. Auth is a per-shop **API key sent as `Authorization: Bearer <key>`** — NOT OAuth. Validate via `GET /auth/api_key/status` → `{"valid":true}`. Orders list via `GET /order` (envelope `{data:[...]}`).

- **`locationId` is effectively optional.** Shopmonkey accounts frequently expose NO location_id at all (the operator/Brandon confirmed he couldn't find one). The API key alone authorizes all `/v3` requests. `locationId`/`companyId` are only used for matching an existing MOS shop in extension-shop-lookup and for the (default-OFF) webhook-subscribe — they are nullable everywhere in `getCredentials`.
  **How to apply:** never require a location/company id to consider Shopmonkey "configured"; key presence is sufficient. Don't block on a missing `SHOPMONKEY_LOCATION_ID`.

- **Amounts are in CENTS** (e.g. order field `appliedDiscountCents`). Confirmed against live `/order` data. Mirror Tekmetric's cents handling; do not divide/treat as dollars.

- **Single-host SPA** at `app.shopmonkey.cloud`. Unlike Shop-Ware/AutoFlow (tenant subdomain), there is no per-shop hostname, so the extension content adapter must discover companyId/locationId from the page (URL params/path or localStorage) rather than the hostname. The exact storage keys / order-page DOM selectors are best-effort and pending live verification on a real Shopmonkey session.

- **Prod-safety:** dev Mongo == prod, so this build is dormant by design — no shops configured, backfills gated behind `SHOPMONKEY_BACKFILL_ENABLED`, webhook auto-subscribe behind `SHOPMONKEY_WEBHOOK_AUTO_SUBSCRIBE`, both default OFF. The new Mongo-touching files were added to the `scripts/check-direct-db.cjs` allowlist (that guard gates the Render prod build).
