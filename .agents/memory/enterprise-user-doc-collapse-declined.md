---
name: Enterprise user-doc collapse declined
description: Why the duplicate per-shop users-doc collapse was investigated and intentionally NOT done.
---

# Collapsing duplicate enterprise `users` docs — declined, do not re-attempt blindly

The multi-location access model was unified on Model B (single users doc carrying a
`shopIds` array) via UNION-read + write-to-all-docs in `lib/enterprise-access.ts`.
A follow-on idea was to physically collapse each user's duplicate per-shop Mongo
docs into ONE doc per email. After investigation, Brandon chose to **leave the
duplicate docs as-is**.

**Why NOT to collapse (the rule):** the app is already consistent for the original
goal *without* collapsing, and collapsing would regress things, because:

1. **Divergent passwords.** Some duplicate-email groups have *different*
   `passwordHash` values across their per-shop docs. Login (`app/api/auth/login`)
   queries by email only (the UI sends no `shopId`) and authenticates against
   `candidates[0]` (natural Mongo order). Collapsing forces picking one password →
   wrong pick locks the user out. (At time of audit: 4 such groups out of 9.)
2. **Readers still assume one-doc-per-shop.** Most importantly the per-shop team
   list `app/api/settings/users` GET filters `{ shopId: sess.shopId }` with NO
   `shopIds` union, so multi-location staff currently appear on every location's
   Users page *because* they have a separate doc per shop. Collapsing would make
   them silently vanish from sibling shops' Users pages. Other shopId-keyed user
   readers (per-shop counts, enterprise "clone users to new shop", platform-admin)
   share the assumption.

**How to apply:** Do not run any collapse/merge of duplicate `users` docs unless
Brandon explicitly re-approves AND the remaining shopId-only readers are first made
Model-B-aware (`$or: [{shopId}, {shopIds: {$in:[shopId, String(shopId)]}}]`), AND
each divergent-password user's *currently-authoritative* password (login's
`candidates[0]`, ≈ lowest `_id`) is the one kept. Remember dev Mongo IS prod Mongo,
so any such write is live and the deletes are irreversible.
