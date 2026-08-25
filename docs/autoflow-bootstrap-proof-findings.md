# AutoFlow extension auto-login (bootstrap) — proof discovery findings

**Conclusion: no viable single-purpose current-user proof exists on either
AutoFlow version, so AutoFlow keeps the calm `unsupported` bootstrap outcome
(side panel shows the normal "sign in with MOS.Tools" prompt).**

This is the documented-fallback path from Task 1178 Step 5. It is recorded here
so the decision is not re-litigated. If AutoFlow later ships a bearer-verifiable
current-user endpoint, revisit `verifyProviderSessionProof` in
`lib/extension-provider-proof.ts` (add an `autoflow` branch mirroring the
Tekmetric/Shopmonkey ones) and the extension capture path.

## The bar a proof must clear

Same security contract as Tekmetric and Shopmonkey:
1. A **narrow, single-purpose** browser-captured credential (a bearer/token),
   never the whole session cookie forwarded wholesale.
2. Server-side **live verification** of that credential against the provider.
3. The provider must independently attest **who** the operator is
   (email and/or a stable subject id) — a client-supplied value is not enough.
4. Provider-attested **shop membership** for the resolved MOS shop.

`matched_user` auto-elevation needs #3 (subject/email). A `basic` read-only
session still needs #2 + #4 (a verified session that belongs to the shop).

## v3 — `*.autotext.me` (legacy PHP / jQuery)

- Pure **cookie session**. The DVI app authenticates every request with the
  PHP session cookie (see `docs`/memory `autoflow-writeback-path`); there is no
  bearer token and no identity XHR the page makes that carries a re-verifiable
  credential.
- `GET https://admin.autotext.me/Admin/index.php` → `302` redirect to login
  when unauthenticated; the authenticated identity lives only behind the cookie.
- Verifying a v3 session would require **forwarding the whole session cookie**
  to the provider — explicitly forbidden by the contract (#1). **Rejected.**
- **Confirmed on a live logged-in v3 session (2026-08-25):** a full HAR capture
  of an authenticated `*.autotext.me` shop showed every request authenticating
  with only the PHP session cookie — no `Authorization`/`X-token`/API-key
  header or token-like parameter anywhere. The page does know the operator
  client-side (chat module embeds `user_id`; a staff-list XHR returns coworker
  emails), but every identity-bearing response is obtainable only in exchange
  for the full session cookie, so nothing narrow exists to forward. v3 is
  definitively closed.

## v4 — `app.autoflow.com` (Laravel + Inertia + Vue)

Probed the public SPA bundle (`/build/assets/app2.js`) and the API host.

- The SPA is **Inertia-based**: the current operator is server-rendered into
  page props (`$page.props.auth.user`), consumed directly by Vue. There is **no
  client-side identity XHR** to intercept — identity never travels as a
  re-verifiable response.
- A **per-user bearer** is kept in `localStorage` (`token`, plus `uid`,
  `shop_id`) and sent as `Authorization: Bearer <token>` / `X-token`. This is a
  narrow credential (#1) and it validates server-side, but there is no endpoint
  that returns the operator's identity with it:
  - Every plausible identity route 404s with just the bearer:
    `/api/user`, `/api/users/me`, `/api/me`, `/api/profile`, `/api/account`,
    `/api/auth/user`, `/api/v1/user`, `/api/v1/me`, `/api/me/shops`, …
    (`{"message":"The route ... could not be found."}` / `not_found`).
  - The **only** bearer-validating endpoint found is
    `POST /api/broadcasting/auth` (Laravel Echo channel auth). With a bad bearer
    it returns **401** (so it does live-verify the token), but a successful
    response is only a **channel signature** — it discloses neither the
    operator's email nor a stable subject id. Its request body even carries a
    **client-supplied** `user_id`/`shop_id`, so it cannot attest identity (#3).
- Net: v4 gives us a live-verifiable token but **no provider-attested
  current-user subject/email (#3)**, so it cannot drive `matched_user`. A
  membership-only `basic` session would additionally require a confirmed
  membership endpoint (`private-shop.<n>` channel semantics, the v4 shop-number
  channel id, and its authorization rule are all unverifiable from an isolated
  env with no logged-in AutoFlow account). **Rejected** — shipping on
  unverified channel semantics would be a guess, not a verified proof.

## What would change the answer

Any of the following, confirmed on a live authenticated AutoFlow session:
- A v4 REST endpoint that, given only the `localStorage` bearer, returns the
  logged-in user's email/subject (e.g. a real `/api/v1/...me`), **and** a
  membership signal for the shop. Then wire an `autoflow` branch exactly like
  Shopmonkey (pin the API/probe host server-side, accept the captured origin as
  context only).
- ~~Confirmation that `POST /api/broadcasting/auth` for a **presence** channel
  returns server-derived `user_info` containing the operator's email.~~
  **Answered NO on a live logged-in v4 session (2026-08-25):** a full HAR
  capture showed the app subscribes to **zero presence channels** — only
  `private-...` channels — and every `broadcasting/auth` response is just
  `{"auth":"<signature>"}` with no `channel_data`/user info. The request body
  carries a client-supplied `user_id`/`shop_id`. The only requests bearing the
  `X-token` credential were those channel-auth calls; the only response
  containing the operator's email was the cookie-authenticated server-rendered
  HTML page. Both AutoFlow versions are now confirmed closed on live sessions.

Until then, AutoFlow stays `unsupported` and no cookies or credentials are
forwarded for it.
