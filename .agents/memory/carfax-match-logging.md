---
name: CARFAX match gap logging & diagnostic
description: How unmatched CARFAX service descriptions are logged and inspected for VHI "not done" reports.
---

CARFAX services show as "not done" in VHI when a free-text/category description
maps to no canonical service key. The matcher is `toKeyFromFreeText` +
`findImpliesResetMatches` (lib/service-keys.ts); a description that resolves to
neither anchors nothing.

**Rule:** any wording added to fix a gap must land in `SERVICE_KEYS` AND stay
mirrored across `toKeyFromName` (single key) and `toKeyFromFreeText` (array) —
the post-loop special-cases in those two functions must agree, or name-sourced
and free-text-sourced history disagree.
**Why:** divergence is exactly what caused the false "not done" reports.
**How to apply:** the smoke test `tests/carfax-match.smoke.ts` asserts
`toKeyFromName(s)` ∈ `toKeyFromFreeText(s)` for shared strings; keep it green.

**Operational:** unmatched descriptions are tallied IN-MEMORY per Node process
(lib/carfax-match-log.ts, mirrors oe-logos pattern) — resets on redeploy, NOT
persisted. Operator surfaces: GET/DELETE `/api/platform-admin/carfax-unmatched`
and the `/platform-admin/carfax-match` page (also runs a per-vehicle diagnostic
via `POST /api/plan-build?diag=carfax&vin=&mileage=&shopId=`, platform-admin
gated, returns breakdown without building/caching a plan).

**Manual overrides (live fix, no deploy):** a platform admin can map a CARFAX
description → canonical key from the carfax-match page. Stored in Mongo
`carfax_service_key_overrides` keyed by `normalizeCarfaxDescription` (lib/carfax-
overrides.ts), one key per description. The matcher (triage `carfaxKeysFor`
helper) and diagnostic UNION the dictionary keys with the override keys, so an
override anchors VHI for ALL shops within ~30s (in-proc cache TTL, busted on
write in-process). CRUD: `/api/platform-admin/carfax-overrides` (GET/POST/DELETE).
**Why mirror the override AND still fix SERVICE_KEYS:** overrides are an
immediate operator patch; the dictionary entry is the permanent fix and keeps
toKeyFromName/toKeyFromFreeText parity. New Mongo-touching route had to be added
to the `lint:direct-db` allowlist (scripts/check-direct-db.cjs) or the Render
prebuild fails.
