---
name: Enterprise user/location management — admin vs owner scope
description: Who can manage team members' location access across an enterprise, and the owner-only boundary; plus the multi-doc-per-email users data model.
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

**Why:** Team Ryan's CEO is an `admin` (not owner). The owner-only gates made his location
dropdown empty (fell back to own-shop-only, then filtered out his primary) and made Save
fail (assigning sibling locations rejected as "outside your enterprise"). The UI already let
him open the modal, so the backend gates were the bug.

**Data-model gotcha — multiple user docs per email:** the Mongo `users` collection can hold
SEVERAL docs with the same email, one per shop (e.g. a multi-location admin had 3 docs:
shopId 85/117/118). Session role resolves from the Mongo user doc (identity is Mongo-canonical;
`IDENTITY_PG_CANONICAL` default off). So a role/data change for such a person should target
all their docs (updateMany by email), not just one, or the session may pick a stale doc.

**Enterprise link lives on the SHOP, not the user:** Team Ryan users had `enterpriseId`
undefined on their user docs; the enterprise is derived from the session shop's `enterpriseId`.
Don't look for enterprise membership on the user record.
