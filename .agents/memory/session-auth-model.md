---
name: Dashboard session auth model (no JWT) + "logged out" debugging
description: How dashboard/web session auth actually works and how to diagnose a user getting logged out / spinner-then-logout.
---

# Dashboard session auth = opaque DB token, NOT JWT

`getSession()` (lib/auth.ts) resolves the `session_token` cookie by looking it
up directly in the session store and checking `expiresAt > now()`. Login
(`app/api/auth/login`) mints an **opaque** token via `crypto.randomBytes(32)` —
there is **no JWT, no HMAC, no signature** anywhere in the web session path.

**Implication:** a "logged out" / spinner-then-logout report is NEVER a
"token signing/verification" bug — there's nothing cryptographic to fail. A
401 strictly means the presented token is not a valid, unexpired row in the
live store (missing, expired, or replaced).

**Live store = Mongo** `mos-maintenance-mvp.sessions`. The Postgres `sessions`
table is gated behind `IDENTITY_PG_CANONICAL` (default OFF) and is currently
**dormant** in prod (handful of rows, none active, none created since
Jan 2026). Don't chase a PG/Mongo cutover gap for session 401s unless that flag
is actually flipped on.

**How to diagnose a single user logged out:**
1. Better Stack: filter host `mos-maintenance-mvp-main`, isolate the user's
   `clientIP`, look at status on `/api/notifications/count` &
   `/api/support/tickets/count` (the dashboard's ~60s auth-polls).
2. Fast 401s (3-15ms) for ONE IP while other users get 200s = that user's
   session row is gone/expired; it is NOT load/saturation (saturation shows
   slow responses or 5xx) and NOT signing.
3. Fix: have them fully log out + back in (mints a fresh session row). To
   verify their exact record, look up their user/email in
   `mos-maintenance-mvp.sessions` (read-only — dev Mongo IS prod Mongo).
