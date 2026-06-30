---
name: Extension reliability contract
description: How the Detect Dog extension must treat backend entitlements and captured RO data so it never flashes a wrong/scary state on a transient blip.
---

# Extension reliability contract

Shared pattern across the side panel: **prefer fast/reliable local data, confirm in
the background, degrade gracefully — never render a wrong/scary state on a transient
backend blip.**

## Feature entitlements (the subscription lock)
- The extension features endpoint MUST distinguish a *transient* failure from a
  genuine "not entitled" answer:
  - Transient (shop-resolution miss under degraded auth, lookup throw, entitlements
    load failure) → respond **503** with `{transient:true, code:"FEATURES_TRANSIENT"}`.
  - Genuine off → normal **200** with the real (possibly all-false) feature flags.
- The client applies features ONLY when a real features payload is present; on a
  transient signal it keeps last-known-good and retries with bounded backoff, guarded
  by a fetch sequence counter so a stale shop's late reply can't be applied.
- **Why:** a transient all-false 200 used to be trusted by the client and rendered the
  upgrade/lock screen for paying shops (e.g. shop 90). Fail-closed locks look like a
  billing bug to the user.
- **How to apply:** any new path in the features route that can't actually evaluate a
  plan must return the transient 503, never an all-off 200. `getFeatureEntitlements`
  takes `opts.throwIfMissing` to surface shop-not-found as a typed
  `ShopEntitlementsUnavailableError` the route maps to 503.

## Captured RO identity vs DOM scrape (Tekmetric)
- Interceptor-captured API JSON (from the SPA's own `/repair-order/{id}` response) is
  the AUTHORITATIVE identity source (VIN, vehicle, customer, mileage, RO#). DOM scrape
  is bootstrap/gap-fill only and must NEVER overwrite an API-sourced field.
- Per-RO cache tracks which fields came from the API (`_apiKeys`); hydrate overwrites
  the scraped context for API fields and only gap-fills the rest.
- **Why:** the Tekmetric SPA briefly renders literal label text ("Name", "Vehicle")
  before React hydrates; trusting the scrape over the API produced garbage identity.
- **How to apply:** the RO cache is keyed by **`shopId:roId`** (not roId alone) so a
  repair-order id can't collide across shops and show the wrong customer on a keytag.
  Keep the interceptor sending `shopId` with `MOS_RO_LOADED`; the scrape side derives
  the same numeric shop id from the page URL.

## Extension-auth 401 bodies must carry the stable `code` (even outside /api/extension/*)
- Any route the extension calls with a `Bearer ext_` token MUST return the canonical
  auth-error body via `buildAuthErrorBody(extAuth)` (includes the stable `code`), not a
  hand-rolled `{ error: "Unauthorized" }`. This applies to extension-facing routes that
  live OUTSIDE `/api/extension/*` too (e.g. `app/api/tekmetric/apply-canned-job`).
- **Why:** the background 401-retry loop classifies terminal vs transient purely off the
  body `code` (`TERMINAL_AUTH_CODES = {TOKEN_INVALID}`). A missing code shows up as
  `code=none`, so every failure is treated as transient — the loop retries the full
  widened budget and we lose all diagnostics about the real reason (was it
  TOKEN_EXPIRED? SHOP_FORBIDDEN? a lookup race?).
- **How to apply:** mirror the Protractor twin `app/api/extension/jobs/apply-canned`
  (already correct). grep for hand-rolled `{ error:` 401s in any `Bearer ext_` branch.

## Print tab instant-fill
- Keytag/oil sticker fill immediately from captured `currentContext` identity and
  unlock Print; the backend ro-context reconcile may enrich but must NOT downgrade or
  re-lock an already-good instant fill on a sparse/error reply.
