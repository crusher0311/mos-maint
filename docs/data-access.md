# Data access guidelines

This document explains how MongoDB access is structured in this codebase
and what the rules are for new code.

## TL;DR

- App code (route handlers, services, jobs, scripts) **must not** call
  `getDb()` or `getMongoClient()` directly.
- Instead, import a function from `lib/data/repositories/<entity>.ts`.
- If the function you need does not exist yet, **add it to a repository
  module** rather than reaching into Mongo from your caller.
- The `pnpm lint:direct-db` script (also run as
  `node scripts/check-direct-db.cjs`) enforces this for new code.

## Why

The codebase has hundreds of files reaching into MongoDB directly. That
makes:

- it hard to change a query shape (e.g. swap a single-field index for a
  compound one) without auditing dozens of call sites,
- it hard to introduce dual-writes / read-shadowing when migrating a
  collection to PostgreSQL,
- it hard to add cross-cutting concerns (timing, tracing, soft deletes,
  caching) without touching every caller,
- testing painful — every caller wants the real Mongo handle.

A thin repository layer turns each *collection access pattern* into a
named function. Callers depend on those names, not on the underlying
shape of the documents or the driver.

## Layout

```
lib/data/
  db.ts                 ← internal: re-exports getDb / getMongoClient
  repositories/
    shops.ts            ← shops collection
    notifications.ts    ← notifications collection
    knowledge-articles.ts
    support-chat-sessions.ts
    announcements.ts
    api-keys.ts         ← api_keys + api_usage_logs
    api-usage.ts        ← api_usage + api_rate_limits
    enterprise.ts       ← enterprise_accounts + recommendation_events
    shop-features.ts
    auto-booking-queue.ts
    users.ts
```

`lib/data/db.ts` is the **only** module outside `lib/mongo.ts` that is
allowed to import the raw Mongo handle. Repositories import from
`@/lib/data/db`; everyone else imports from `@/lib/data/repositories/*`.

### Naming

Each repository owns one Mongo collection (or a tightly coupled small
group, e.g. `api_keys` + `api_usage_logs`). Functions are plain
exported async functions, not classes. Names describe intent
(`findShopByShopId`, `markAllReadForUser`), not Mongo verbs
(`updateOne`).

### Filters and projections

Repositories accept structured arguments (e.g. `shopId`,
`{ limit, unreadOnly }`) rather than raw Mongo filters whenever
possible. When a small number of callers genuinely need to vary the
filter, the function takes a typed `Filter<Document>` parameter so the
caller stays narrow but does not need a new function for every variant.

## Adding a new operation

1. Find the repository for the collection (or add a new file under
   `lib/data/repositories/`).
2. Write or extend a function that captures the access pattern.
3. Import that function from your caller.
4. Re-run `pnpm lint:direct-db`.

If your code legitimately needs the raw Mongo handle (driver-level
operations, drain scripts, one-off migrations), add the file to the
allowlist in `scripts/check-direct-db.cjs` *and* explain why in the
commit message. New allowlist entries should be rare.

## Migration status

This was introduced incrementally as part of task #298. The repository
layer was created and the following frontline modules were migrated to
use it:

- `lib/notifications.ts`
- `lib/knowledge-base.ts`
- `lib/support-chat.ts`
- `lib/announcements.ts`
- `lib/features.ts`
- `lib/external-api/api-keys.ts`
- `lib/enterprise.ts`

The remaining ~370 files that still call `getDb()` / `getMongoClient()`
directly are listed in the allowlist in
`scripts/check-direct-db.cjs`. They will be migrated in follow-up
work — and crucially, the lint script ensures **no new files** can join
that list. Any file removed from the allowlist that still calls
`getDb()` will fail the lint, and any file newly calling `getDb()` that
isn't on the list will fail the lint.

The largest legacy callers (each will get its own targeted
repository before migration):

- `lib/integrations/protractor.ts` (17 sites — many cache collections)
- `lib/auto-booking/scheduler.ts` (12 sites)
- `lib/api-usage-tracker.ts` (10 sites)
- `lib/integrations/autovitals.ts` (8 sites)
- `lib/integrations/tekmetric/adapter.ts` (7 sites)
- `app/api/webhooks/shopware/route.ts` (7 sites)

A separate downstream task ("Retire dual-writes / consolidate Mongo
access") tracks the remaining bulk migration.

## Postgres / Drizzle

Drizzle's `getDb()` (from `@/lib/db/drizzle`) is **out of scope** for
this rule — it is a different module name that happens to share a
function name. The lint script only matches imports from `@/lib/mongo`
and the relative variants, so Drizzle code is unaffected.
