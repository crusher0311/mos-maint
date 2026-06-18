---
name: Enterprise user/location management — admin vs owner scope
description: Who can manage team members' location access across an enterprise, the owner-only boundary, the multi-doc-per-email users data model, and the two competing access models that must stay unified.
---

**Design boundary (intended, keep consistent):**
- The Users settings UI gates the "Edit Location Access" modal on `canManageUsers = owner || admin`.
  The backing endpoints must match: BOTH owner and admin get enterprise-wide scope for
  *viewing the location list* and *assigning a user's shopIds within the enterprise*.
  - `app/api/shops/list/route.ts` — enterprise branch (returns all shops sharing the
    session shop's `enterpriseId`).
  - `app/api/settings/users/[userId]/route.ts` — GET/PATCH/DELETE cross-shop guards AND the
    PATCH `shopIds` enterprise-validation.
- **Owner-only stays owner-only:** changing a user's ROLE (PATCH `body.role`) is gated on
  `owner` only — an admin must NOT be able to elevate roles (privilege-escalation guard).
- Every cross-shop branch still enforces `sessionShop.enterpriseId === userShop.enterpriseId`,
  so broadening to admin never crosses enterprise boundaries. If the session shop has no
  `enterpriseId`, scope falls back to the user's own shopIds — safe.

**Why:** an enterprise CEO can be an `admin` (not owner). Owner-only gates made his location
dropdown empty (fell back to own-shop-only, then filtered out the primary) and made Save
fail (assigning sibling locations rejected as "outside your enterprise"). The UI already let
him open the modal, so the backend gates were the bug.

**Two competing access models — MUST stay unified:** location access has been tracked two ways:
- Model A: one `users` doc PER shop (same email/passwordHash duplicated per shopId).
- Model B: a single `users` doc with a `shopIds` array.
The Postgres (Wave 4) identity model is built around Model B (a `shop_ids` column), so the
canonical direction is Model B. The enterprise endpoints (`app/api/dashboard/enterprise-users`
+ `app/api/enterprise/users`) and User Settings used to disagree because the former wrote
Model A and the latter Model B. Unified via `lib/enterprise-access.ts`: read access as the
UNION of `shopId` + `shopIds` (tolerant of leftover duplicate docs, no migration needed),
WRITE the complete shop list (as STRINGS, matching the Settings writer) to EVERY one of the
user's enterprise docs so whichever doc a page targets shows the same set; revoke also deletes
leftover duplicate per-shop docs / repoints a sole doc and guarantees ≥1 location.
**Why all-docs writes:** Settings PATCH targets one specific doc by `_id`; if only a single
"canonical" doc were written, Settings could show a stale doc while Enterprise Overview unions
a different one. **Deferred (operator-gated):** collapsing duplicate docs to one per email is a
live-prod data cleanup, not done in the code phase.

**API routes need their own authz — page guards don't cover them:** `app/admin/layout.tsx`
only gates the `/admin/*` *pages* (role `admin`/`platform_admin` else redirect). The
`/api/enterprise/users` route is called directly and must enforce its own check: platform admin
may manage any enterprise; otherwise owner/admin whose session shop's `enterpriseId` matches
the target. Without it, any authenticated user could grant/revoke by supplying `enterpriseId`.

**Data-model gotcha — multiple user docs per email:** the Mongo `users` collection can hold
SEVERAL docs with the same email, one per shop. Session role resolves from the Mongo user doc
(identity is Mongo-canonical; `IDENTITY_PG_CANONICAL` default off). So a role/data change for
such a person should target all their docs (updateMany by email), not just one, or the session
may pick a stale doc.

**The `users` collection has a UNIQUE index `(shopId, emailLower)`:** any insert of a new user
doc must set `emailLower` (= `email.toLowerCase()`), or it collides with existing
null-`emailLower` docs → E11000 → 500. This bit the enterprise grant path.

**Enterprise link lives on the SHOP, not the user:** enterprise users often have `enterpriseId`
undefined on their user docs; the enterprise is derived from the session shop's `enterpriseId`.
Don't look for enterprise membership on the user record.

**Type inconsistency to normalize:** `enterprise_accounts.shopIds` and `shops.shopId` are
NUMBERS; `users.shopIds` entries are STRINGS (Settings writes `.map(String)`). Compare via
`String()`/`Number()`. UI pages compare `shopAccess[].shopId` as a NUMBER, so the API response
must keep that field numeric even though the stored array is strings.

**Extension shop access is gated purely on `user.shopId + user.shopIds` — NO enterprise/owner
expansion by default.** `getUserShopIds` (lib/extension-auth.ts) = just those two fields;
`findShopBySmsId` (lib/extension-shop-lookup.ts) filters the shop lookup to `shopId $in
userShopIds` for non-platform-admins. So an enterprise OWNER/ADMIN who only has their primary
shop in `shopIds` is FAIL-CLOSED out of the extension at every OTHER enterprise location with
"No accessible shop configured for SMS shop ID <smsId>". **Why:** owners' own multi-location
access is frequently never set — the web Users UI is used to add *employees* to locations but
nobody adds the owner themselves. **One-off data fix:** set the affected user's `shopIds` to
include all their enterprise shopIds on the doc that carries their extension token / web session
(for multi-doc users, the `shopId`-primary doc with `extensionToken`).

**Systemic fix (in code — additive, role-gated, best-effort):** `validateExtensionToken` calls
`attachEnterpriseAccess(db, user)`, which — only for `owner`/`admin` — looks up the
enterpriseId(s) of the user's base shops and unions in all sibling shops sharing those
enterpriseId(s), stashing the result on `user.accessibleShopIds`. `getUserShopIds` folds
`accessibleShopIds` in (also role-gated), so EVERY extension route that gates via
`getUserShopIds` picks it up with zero per-route change. Mirrors the dashboard
`GET /api/shops/list` enterprise query (reads `enterpriseId` straight off the shop docs →
string/ObjectId agnostic). DB hiccup → falls back to base shopIds, never a lockout.

**smsId → shop resolution:** the extension's "SMS shop ID" is the PROVIDER's id (e.g.
`tekmetric.shopId`), not the MOS `shopId`. `findShopBySmsId` checks many provider fields.
