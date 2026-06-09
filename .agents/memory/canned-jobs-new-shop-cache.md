---
name: Canned jobs not loading for newly onboarded shops
description: Why the extension "canned jobs" list is empty for new Tekmetric shops while older shops work.
---

# Canned jobs not pulling for new shops

Route: `app/api/extension/canned-jobs/route.ts`. For Tekmetric it reads the Mongo
`tekmetric_canned_jobs_cache` (keyed by **tekmetric** shopId, 1hr TTL); on miss it calls
`getCannedJobs` live (up to 20 pages, each wrapped in a 5s `withUpstreamTimeout`; on page
timeout it breaks the loop and returns whatever it has — often nothing).

## Mechanism
- Newly onboarded shops have **no warm cache row** (e.g. the "Casey" HEART shops tek
  18007/18008/18009 had none; older HEART shops 469/470/471/7718 did).
- Tekmetric `getCannedJobs` is **known-slow for HEART** (route comment cites 14s+ in prod).
  With no cache and a slow upstream, the first page times out at 5s → loop breaks → empty →
  "canned jobs not pulling into the extension."

## NOT the cause
Entitlement: founder plan (`detect_dog_founder`) grants all features incl. `job_lookup`, so
the `guardExtensionShopRequest(... requiredFeatures:["job_lookup"])` gate passes.

## Fix directions (ask Brandon first; cache writes hit PROD Mongo since dev Mongo == prod)
1. Pre-warm `tekmetric_canned_jobs_cache` for new shops (one successful fetch makes
   subsequent loads instant for an hour).
2. Harden the live path (longer/parallel page fetches, serve stale cache on failure).
3. Confirm the shop actually HAS canned services configured in Tekmetric — a brand-new shop
   may legitimately have none (shop-setup issue, not our bug).
