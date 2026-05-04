# DB Wave 4 cutover — identity, sessions, billing & settings

Task: **#346 — DB switchover Wave 4**.
Downstream: **Decommission MongoDB** (after a full soak across W3 + W4).

This runbook flips the canonical store for the W4 entities from MongoDB
to Postgres during a brief maintenance window. The auth surface (custom
session cookie + bcrypt + Chrome-extension token) is unchanged; only
where those records *live* changes.

W4 collections in scope:

```
enterprise_accounts  shops                 users
sessions             shop_users            shop_features
platform_admins      platform_settings     platform_plans
pending_signups      setup_tokens          password_reset_tokens
billing_settings     billing_status_log
stripe_events        stripe_webhook_events
```

The PG schema is `lib/db/schema/wave4.ts`, the migration is
`drizzle/0015_wave4.sql`, the read/write surface is
`lib/data/repositories/pg/identity.ts`, and the kill-switch lives in
`lib/db/wave4-write-mode.ts`.

---

## Architecture summary

* **`IDENTITY_PG_CANONICAL=1`** → central libs (`lib/auth.ts`,
  `lib/extension-auth.ts`, `lib/super-admins.ts`, `lib/shops.ts`,
  `lib/featureResolver.ts`, `lib/stripe.ts`) read & write Postgres.
* **`WRITE_MONGO_IDENTITY=1`** (default ON for the soak) → those same
  central-lib writes are mirrored to MongoDB via
  `shadowWriteMongoIdentity()`. Set to `0` once we're confident nothing
  needs to roll back.
* **Backfill**: `tsx scripts/backfill-mongo-to-supabase.ts --mirror=all-w4`
  copies all W4 collections in dependency order (enterprises → shops →
  users → … → stripe webhook events). It is resumable and idempotent.

### Direct-callsite inventory (NOT routed through central libs)

The central-lib refactor covers ~80% of identity/billing traffic. The
following hot-path API routes still call `db.collection("…")` directly
and will continue writing to **MongoDB** until they're refactored
post-cutover or until an in-window operator does so. As long as
`WRITE_MONGO_IDENTITY=1`, the central libs replay these writes back to
Mongo, but writes that originate at these routes only land in Mongo
during the soak — that's why the **post-window backfill** step below is
required (it brings PG back in sync with any Mongo-only writes that
happened mid-window).

Top callers, by number of `db.collection("…")` references:

| File                                              | Refs |
|---------------------------------------------------|-----:|
| `app/api/stripe/webhook/route.ts`                 |   23 |
| `app/api/settings/users/[userId]/route.ts`        |   14 |
| `app/api/dashboard/enterprise-users/route.ts`     |   13 |
| `app/api/platform-admin/shops/[shopId]/route.ts`  |   12 |
| `app/api/auth/login/route.ts`                     |    8 |
| `app/api/auth/signup/route.ts`                    |    7 |
| `app/api/admin-login/route.ts`                    |    6 |
| `app/api/auth/reset-password/route.ts`            |    5 |
| `app/api/billing/portal/route.ts`                 |    4 |
| `app/api/platform-admin/plans/route.ts`           |    4 |

Each of these gets a follow-up "Refactor to repo" task post-cutover.

---

## Pre-window (T-1 day)

1. **Schema is live in PG (idempotent):**
   ```bash
   psql "$DATAONE_DATABASE_URL" -f drizzle/0015_wave4.sql
   ```
2. **First backfill run** (with `IDENTITY_PG_CANONICAL` *unset* — Mongo
   is still canonical):
   ```bash
   tsx scripts/backfill-mongo-to-supabase.ts --mirror=all-w4
   ```
   Watch for `coverage>=99%` for every spec at the verification step.
   Re-run any spec that came back `DRIFT(under)`.
3. **Sanity-spot-check** PG row counts vs Mongo for the two largest
   tables (`shops`, `users`):
   ```bash
   tsx scripts/backfill-mongo-to-supabase.ts --mirror=shops --verify-only
   tsx scripts/backfill-mongo-to-supabase.ts --mirror=users --verify-only
   ```

## Maintenance window (T0)

1. **Drain & freeze writes.** Put the app behind the maintenance page
   (or scale `MOS Maintenance MVP` to 0 replicas while we work).
2. **Final delta backfill** — captures any Mongo writes since step 2:
   ```bash
   tsx scripts/backfill-mongo-to-supabase.ts --mirror=all-w4
   ```
   Verify all 16 specs end with `OK` (≤ tolerance of 5 rows).
3. **Flip the canonical flag** in deployment env:
   ```
   IDENTITY_PG_CANONICAL=1
   WRITE_MONGO_IDENTITY=1     # keep mirroring during soak
   ```
4. **Restart the workflow** so the new env is picked up:
   ```
   restart_workflow "MOS Maintenance MVP"
   ```
5. **Smoke test** (in this exact order — each step exercises a different
   central lib):
   * Log in via the dashboard (`/login`) — exercises `lib/auth.ts`
     session lookup against PG.
   * Hit a `getSession()`-protected page (e.g. `/dashboard`) — same.
   * Authenticate the Chrome extension against `/api/auth/verify` —
     exercises `lib/extension-auth.ts`.
   * Open the platform-admin Billing settings page — exercises
     `lib/stripe.ts:getBillingSettings`.
   * Toggle a feature on a shop — exercises
     `lib/featureResolver.ts:updateShopFeatures`.
6. **Open the maintenance page.**

## Post-window (T+24h soak)

Auth-critical write paths (login, platform-admin login, switch-shop,
impersonate, signup completion via `complete-setup` / `setup-complete`,
password change/reset, every session-revocation site, and shop
delete) **dual-write into Postgres synchronously** via
`dualWritePgIdentity()` (`lib/db/wave4-write-mode.ts`). With
`IDENTITY_PG_CANONICAL=1`, those writes await the PG insert/update
before the response is returned, so a freshly-issued session cookie
is always readable by `getSession()` on the very next request — there
is no window where a logged-in user appears logged out.

The remaining ~50 non-auth direct callsites (vehicle ingestion,
dashboards, integration settings, etc. — full inventory above) still
write Mongo-only during the soak. Those are converged via
**mandatory periodic delta backfills**:

| When                 | What                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| T0 + 5 min           | `tsx scripts/backfill-mongo-to-supabase.ts --mirror=all-w4` — first delta sweep, run **before** any external traffic touches the app |
| Every 5 min for 1h   | Same command on a loop / cron. Watch the verifier — every spec must remain `OK` |
| Every 15 min, 1h–24h | Same command. Any spec returning `DRIFT(under)` → page on-call         |
| T+24h                | Final delta + `ALTER TABLE users VALIDATE CONSTRAINT users_shop_id_fkey;` (this is the `NOT VALID` FK from `0015_wave4.sql`) |

Verification checkpoints (all must pass before flipping
`WRITE_MONGO_IDENTITY=0`):

1. **Auth smoke at T+0** (immediately after the flag flip, before
   reopening traffic): exercise login → `/api/auth/me` →
   `switch-shop` → `/api/auth/me` → password reset → re-login, with a
   real cookie. Every step must pass without a backfill in between
   (the `dualWritePgIdentity()` calls in the auth routes are what
   make this possible). If any step 401s, **roll back** — do not open
   traffic.
2. Every W4 mirror reports `OK` (≤ tolerance) at T+1h, T+6h, T+24h.
3. `ALTER TABLE users VALIDATE CONSTRAINT users_shop_id_fkey` succeeds
   without errors. If it fails on orphans, fix the offending Mongo
   docs (normally a handful of legacy platform-admin accounts) and
   re-run.
4. Workflow logs contain zero `[DualWritePgIdentity]` errors and
   zero `[ShadowMongoIdentity]` errors over the last 24h.

Once all three pass:
```
WRITE_MONGO_IDENTITY=0
```
Restart the workflow. Mongo identity becomes append-only history.
The periodic delta backfill cron can be retired at the same time.

After 7 days: schedule the `Decommission MongoDB` task. Follow-up
#371 (route-level migration) and #372 (continuous parity monitor)
should land before that to remove the dependency on the periodic
delta backfill entirely.

## Rollback

If something breaks during the smoke-test:

1. Set `IDENTITY_PG_CANONICAL=0` and restart the workflow. All central
   libs revert to Mongo reads/writes immediately. Because
   `WRITE_MONGO_IDENTITY=1` was on during the brief PG-canonical
   period, every write that hit PG was also mirrored to Mongo, so the
   two stores stay aligned. No data is lost.
2. File a follow-up ticket capturing the failure and re-plan.
