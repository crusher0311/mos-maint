/**
 * Write-mode flags for the Wave 4 cutover (task #346 — identity,
 * sessions, billing, settings).
 *
 * Two flags drive every W4 callsite:
 *
 *   IDENTITY_PG_CANONICAL  ("1" | unset/"0", default OFF)
 *     The polarity flip. When ON, the central identity libraries
 *     (lib/auth.ts, lib/extension-auth.ts, lib/super-admins.ts,
 *     lib/shops.ts, lib/enterprise.ts, lib/featureResolver.ts,
 *     lib/features.ts, lib/stripe.ts) read and write from Postgres
 *     instead of Mongo. This flag is flipped exactly once during the
 *     announced maintenance window (see docs/runbooks/db-w4-cutover.md).
 *
 *   WRITE_MONGO_IDENTITY   ("0" | unset/anything else, default ON)
 *     Soak-window kill switch for the optional Mongo shadow write that
 *     keeps the legacy collection in lock-step with Postgres for the
 *     24–168h post-cutover safety window. Same polarity as the W3b
 *     flags in `wave3-write-mode.ts`: any value other than the literal
 *     string "0" leaves shadow writes enabled. Operators flip this to
 *     "0" once the soak passes; the W4 decommission task drops the
 *     Mongo collections entirely after that.
 *
 * Both flags are read on every call so toggling is a no-deploy
 * operation (set/unset env, the next request picks it up).
 */

/** PG-canonical when "1"; default false (Mongo canonical) until cutover. */
export function isIdentityPgCanonical(): boolean {
  return process.env.IDENTITY_PG_CANONICAL === "1";
}

/** Mongo shadow-write enabled by default; flip to "0" to retire. */
export function shouldShadowWriteMongoIdentity(): boolean {
  return process.env.WRITE_MONGO_IDENTITY !== "0";
}

/**
 * Generic shadow-write wrapper, mirroring `shadowWriteMongo` in
 * `wave3-write-mode.ts`. Calls `fn` iff the flag is ON. Errors are
 * logged but never thrown — Mongo is no longer canonical post-cutover,
 * so a transient Mongo outage must not break the request path.
 */
export async function shadowWriteMongoIdentity(
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  if (!shouldShadowWriteMongoIdentity()) return;
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ShadowMongoIdentity] write failed (non-fatal) — ${label}: ${msg}`,
    );
  }
}

/**
 * Synchronous dual-write into Postgres for the auth-critical routes
 * that still write Mongo-first (login, switch-shop, signup completion,
 * platform-admin login/impersonate, password change/reset, session
 * revocation). When `IDENTITY_PG_CANONICAL=1`, the central libs
 * (`lib/auth.ts`) read sessions/users from PG on the very next
 * request — if the route's session insert never reaches PG the user
 * is effectively logged out. We therefore await this write and
 * surface failures (unlike the Mongo shadow). When the flag is OFF
 * the call is a no-op so existing pre-cutover behaviour is unchanged.
 *
 * Once follow-up #371 finishes migrating the route-level callsites
 * to PG-canonical repos directly, these dual-write hops disappear.
 */
export async function dualWritePgIdentity(
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  if (!isIdentityPgCanonical()) return;
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[DualWritePgIdentity] write failed — ${label}: ${msg}`,
    );
    throw err;
  }
}
