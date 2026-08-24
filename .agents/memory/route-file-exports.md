---
name: Route files export handlers only
description: Next route.ts extra exports break typecheck via .next/types
---
Next's generated .next/types check rejects any non-handler export from an app router route.ts (e.g. __deps, __verifySignature test seams) — `npm run typecheck` fails once the route has been built.
**Why:** hit on app/api/webhooks/tekmetric/route.ts; the error only appears for routes present in .next/types, so it can lurk until a build.
**How to apply:** put test seams/helpers in a sibling module (deps.ts, verify-signature.ts) and import them from the route; tests import the sibling.
