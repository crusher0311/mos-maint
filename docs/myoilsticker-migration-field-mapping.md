# MyOilSticker → mos.tools migration: field mapping

Task #1181. Legacy source: MongoDB database `test` on the same cluster
(`users` 522 docs, `customgroups` 3, `overviews` 2,610, `adminsettings` 1,
`oildatas` ~895,560). Script: `scripts/migrate-myoilsticker-users.ts`.
Runbook: `docs/myoilsticker-migration-runbook.md`.

Model: **one legacy user = one mos.tools shop + one owner user.**

## `test.users` → mos.tools

All 522 docs carry every field below unless a count is noted.

| Legacy field | Present | Destination | Notes |
|---|---|---|---|
| `_id` | 522 | `users.legacyOilStickerId` + `shops.legacyOilStickerId` (hex string) | Idempotency/resume tag; also rollback key |
| `email` | 522 | `users.email` / `users.emailLower`, `shops.contactEmail` | lowercased/trimmed; 0 in-legacy duplicates; 155 collide with existing mos users (see rules) |
| `password` | 522 | `users.passwordHash` | All are bcrypt `$2b$10$…`, carried **as-is**; mos login verifies bcrypt directly |
| `firstName`+`lastName` | 522 | `users.name` | joined |
| `phoneNumber` | 522 | `users.phone` | |
| `isAdmin` | 522 (2 true) | `legacyMyOilSticker.isAdmin` | NOT mapped to any mos admin role — legacy admins get ordinary owner accounts |
| `isFrozen` | 522 (0 true) | `legacyMyOilSticker.isFrozen` (+ disabled-login rule) | See rules below |
| `isEmailVerified` | 522 (520 false) | `legacyMyOilSticker.isEmailVerified` | Recorded only; does not gate login (see rules) |
| `createdAt` | 522 | `users.createdAt`, `shops.createdAt` | original signup date preserved |
| `targetShopTag` | 522 | `shops.name`, `stickerConfig.tagline` | shop tag doubles as shop name (fallback: first+last name) |
| `targetPhone` | 522 | `shops.phone`, `stickerConfig.phone` | phone printed on sticker |
| `targetMile` / `targetMonth` | 522 | `stickerConfig.intervals.conventional.{mileage,months}` + `defaultOilType:"conventional"` | legacy has ONE interval; it becomes the default oil type's interval |
| `stickerSize` | 522 | `stickerConfig.defaultSize` | values seen: `2x2` (505), `2x3.5` (17) — both valid mos sizes |
| `serviceUnit` | 522 | `stickerConfig.useKilometers` | `"kms"` → true (4 users), `"miles"` → false |
| `text` | 326 | `stickerConfig.serviceLabel` | e.g. "Next Service Due" (default used when absent) |
| `stickerStatus` | 520 | `stickerConfig.enabled` | |
| `targetColor` | 522 | `stickerConfig.colors.text` | |
| `stickerBGColor` | 521 | `stickerConfig.colors.background` | |
| `stickerPhoneColor` | 519 | `stickerConfig.colors.phoneColor` | |
| `stickerShopTagColor` | 519 | `stickerConfig.colors.taglineColor` | |
| `roundMileage` | 522 | `stickerConfig.roundMileage` | |
| `predictiveDate` | 522 | `stickerConfig.usePredictiveDate` | |
| `targetSchedule` | 522 | `stickerConfig.appointmentUrl` | schedule/QR URL |
| `hovercode` | 522 | `stickerConfig.hovercodeQRId` | existing HoverCode QR id reused; no re-provisioning |
| `carfaxEnable` | 500 | `shops.carfax.enabled` | |
| `carfaxLocationId` | 500 (mostly empty) | `shops.carfax.locationId` | only when non-empty |
| `timeZone` | 387 | `shops.timezone` | abbreviations mapped to IANA (`EST`→`America/New_York`, etc.) |
| `lat` / `lon` | 324 | `shops.location.{lat,lon}` | |
| `shopNum` | 522 | `legacyMyOilSticker.shopNum` | legacy SMS shop number (metadata only) |
| `isSubscribed`, `subDescription`, `monthBilled`, `hasUsedTrial` | 522 | `legacyMyOilSticker.*` | billing flags recorded as metadata only; no Stripe/billing migration (out of scope) |
| `laborEnable`, `enableAutobook` | 522 / 402 | `legacyMyOilSticker.*` | metadata only |
| `targetSiteType`, `targetURL` | 522 | `legacyMyOilSticker.*` | which third-party SMS the legacy scraper targeted (no credentials) |

### NOT migrated (deliberately dropped)

| Legacy field | Why dropped |
|---|---|
| `targetPwd` | scraped third-party SMS **password** — sensitive, never copied |
| `targetUser` | scraped third-party SMS login username — sensitive, dropped |
| `cookieInfo`, `cookieExpire` | scraped third-party session cookies |
| `tokenInfo`, `tokenExpire` | scraped third-party tokens |
| `apiKey` | legacy platform API key — meaningless/unsafe on mos.tools |
| `__v` | mongoose internal |

## Explicit rules

- **Email collisions (155 at audit time):** never duplicated. Default
  `--collisions=link` tags the *existing* mos user with
  `legacyOilStickerId` + `legacyMyOilSticker` metadata and changes nothing
  else (no credentials, no shop, no settings). `--collisions=skip` reports
  only. Each collision is listed individually in the report for operator
  review.
- **Frozen (`isFrozen: true`):** imported **disabled** — passwordHash is
  replaced with a random unguessable bcrypt hash and
  `mustChangePassword: true` is set (`legacyDisabledReason: "isFrozen"`).
  0 accounts are frozen at audit time; the rule is enforced regardless.
- **Unverified (`isEmailVerified: false`, 520/522):** migrated normally with
  the flag recorded in metadata. mos.tools doesn't gate login on email
  verification, and treating unverified as disabled would lock out ~all
  legacy customers.
- **Non-bcrypt hash (0 at audit time):** same disabled treatment as frozen
  (`legacyDisabledReason: "no-usable-hash"`).

## Other legacy collections

- `customgroups` (3 docs) → `shops.legacyCustomGroups[]` on the owning
  user's new shop (`{name, makes, laborRateCents, legacyGroupId}`); for a
  collision-linked user they ride along in `legacyMyOilSticker.legacyCustomGroups`
  (the pre-existing shop is never modified). mos.tools has no direct
  custom-make-group feature; kept as structured metadata. 2 of the 3 groups
  reference a deleted legacy user (orphans) and are reported, not migrated.
- `oildatas` (~895,560 sticker-print history rows) → **NOT migrated** (out of
  scope). Linkage key: `oildatas.user_id` → `test.users._id` → mos
  `users.legacyOilStickerId`. Volume + key are reported by every script run.
- `overviews` (2,610) → not migrated: legacy billing/payment event log
  (email + amount); superseded by the recorded subscription metadata.
- `adminsettings` (1 doc) → not migrated: global legacy CARFAX credentials;
  mos.tools uses env-level CARFAX config (`CARFAX_POST_URL`/`CARFAX_PDI`).
- `vehicles`, `customers`, `repair_orders`, `jobs`, `reviews`,
  `defaultoildatas` → not in task scope.

## Entitlements & rollback tagging

- Every created shop gets `billing: { plan: "oil_sticker_legacy", status: "active" }`
  — the plan tier that includes the `oil_sticker` feature — plus the explicit
  per-shop override `enabledFeatures: { oil_sticker: true }`, so the feature
  gate on sticker endpoints permits migrated shops immediately. Verified by
  `npm run test:myoilsticker-migration`.
- Created shops and users additionally carry `legacyMigrationCreated: true`;
  collision-linked pre-existing users never do. Rollback deletes select ONLY
  on that flag (see runbook).
- Crash safety: if a run dies between the shop insert and the user insert, a
  re-run finds the shop already tagged with the same `legacyOilStickerId`,
  reuses its shopId, and completes the user insert (PG mirrors are
  insert-on-conflict-do-nothing, so replays are safe).

## Notable decisions

- New shops do **not** run `seedDefaultAdmins` (would append ~370 shop ids to
  each platform admin's `shopIds`); platform admins already reach any shop.
- PG identity dual-write: user/shop inserts and collision tags go through
  `dualWritePgIdentity` so the wave-4 PG mirrors stay consistent with
  whatever write-mode flags are active in the environment where the run
  happens.
