---
name: Canned jobs not loading for newly onboarded shops
description: Why the extension "canned jobs" list is empty for new Tekmetric shops while older shops work.
---

# Canned jobs not pulling for new shops

Route: `app/api/extension/canned-jobs/route.ts`. For Tekmetric it reads the Mongo
`tekmetric_canned_jobs_cache` (keyed by **tekmetric** shopId, 1hr TTL); on miss it calls
`getCannedJobs` live (up to 20 pages, each wrapped in a 5s `withUpstreamTimeout`; on page
timeout it breaks the loop and returns whatever it has — often nothing).

## Confirmed root cause: empty-cache poisoning (NOT a missing row, NOT slowness)
The real failure is a self-perpetuating empty cache, not the originally-suspected
"new shop has no row" or "HEART upstream is too slow":
- The cache-hit check requires `cannedJobs.length > 0`, so a row with `cannedJobs: []`
  behaves as a **permanent miss**.
- The live-fetch path used to `upsert` the result **unconditionally** — so a single
  timed-out/transient-empty fetch wrote `cannedJobs: []`, poisoning the row. Every later
  request then saw rows=0 → treated as miss → re-fetched → re-wrote empty → forever.
- The two Palatine shops (tek 18009/mos 122, tek 18007/mos 123) actually **HAVE** canned
  jobs (97 and 74) and the live fetch is **fast** (~700ms / ~167ms, single page) — they
  were just stuck on poisoned empty rows.

## The durable fix (in route)
1. **Never cache an empty result** — only upsert when `cannedJobs.length > 0` (both the
   tekmetric and protractor branches).
2. **Serve last-known-good cache ignoring the 1h TTL** when the live fetch returns empty.
3. **One first-page retry (8s)** for tekmetric to ride out a single slow response.
**Why:** a transient upstream blip must never overwrite good cached data with empty, and a
miss should degrade to slightly-stale rather than to nothing.

## NOT the cause
Entitlement: founder plan (`detect_dog_founder`) grants all features incl. `job_lookup`, so
the `guardExtensionShopRequest(... requiredFeatures:["job_lookup"])` gate passes.

## Fix directions (ask Brandon first; cache writes hit PROD Mongo since dev Mongo == prod)
1. Pre-warm `tekmetric_canned_jobs_cache` for new shops (one successful fetch makes
   subsequent loads instant for an hour).
2. Harden the live path (longer/parallel page fetches, serve stale cache on failure).
3. Confirm the shop actually HAS canned services configured in Tekmetric — a brand-new shop
   may legitimately have none (shop-setup issue, not our bug).
