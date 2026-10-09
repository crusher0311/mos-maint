---
name: Route files export handlers only
description: Next route.ts extra exports break typecheck via .next/types
---
Next's generated .next/types check rejects any non-handler export from an app router route.ts (e.g. __deps, __verifySignature test seams) — `npm run typecheck` fails once the route has been built.
**Why:** hit on app/api/webhooks/tekmetric/route.ts; the error only appears for routes present in .next/types, so it can lurk until a build.
**How to apply:** put test seams/helpers in a sibling module (deps.ts, verify-signature.ts) and import them from the route; tests import the sibling.

Thin route entrypoints are also acceptable when retaining a complex handler
unchanged is safer than splitting its dependencies. Keep HTTP method exports
and literal Next configuration at the entrypoint; keep test seams in the
companion implementation.

**Why:** Moving a handler changes what source-based security checks inspect.
Checking only the wrapper can miss authorization, while silently ignoring an
unreadable delegate can exclude the route from the security inventory.

**How to apply:** Security checks must follow only validated local adapters,
inspect the real handler, and fail closed for missing or malformed delegates.
Test those negative cases as well as method/configuration parity. Run an
explicit typecheck after a full build regenerates every route declaration;
a green typecheck against a partial development cache is insufficient.
