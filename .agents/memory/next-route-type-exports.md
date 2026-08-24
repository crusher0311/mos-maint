---
name: Next route files reject extra exports
description: tsc against .next/types fails on any non-handler export from a route.ts (test seams like __deps/__verifySignature)
---
Next's generated `.next/types/app/**/route.ts` check forbids any export from a route file beyond handlers/config. Only routes with generated type files fail — many routes still export `__deps` test seams and pass only because their types were never generated (dev never compiled them). Any dev-server visit can generate types and break typecheck later.

**Why:** Tekmetric webhook route's exported `__verifySignature`/`__deps` seams broke `npm run typecheck` once its `.next/types` file existed (2026-08-24).

**How to apply:** put test seams in a sibling module (e.g. `deps.ts`, `verify-signature.ts`) the route imports; tests import the sibling. If HMAC/auth code moves out of the route file, the unauthed-routes lint must recognize the call site (`verifySignature(` pattern added) — update AUTH_PATTERNS + fixtures in the same change.
