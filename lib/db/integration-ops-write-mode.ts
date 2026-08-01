/**
 * Write-mode flags for the integration OPERATIONAL-store cutover (task #999).
 *
 * These cover the operational state the integration machinery keeps in
 * Mongo-only collections — backfill progress/health/perm-failed/skips/
 * catchups, drain locks, webhook logs/subscriptions/health, tokens,
 * api-usage, Protractor deferred/callback/service-item/template stores,
 * Shop-Ware backfill ("ln") / webhook stores, and the AutoVitals
 * appointment/inspection/import stores.
 *
 * They deliberately mirror `lib/db/integration-cache-write-mode.ts`
 * (task #556) but are SEPARATE flags: the *data* caches
 * (tekmetric_work_orders etc.) and the *operational* stores flip
 * independently. Like the cron-lock / rate-bucket precedent
 * (`lib/db/schema/operational.ts`), most of this state is transient, so
 * the cutover is a pure flag flip with no backfill; only the durable
 * logs (webhook logs, api-usage, skip/perm-failed history) get an
 * operator backfill first (`scripts/backfill-integration-ops.ts`).
 *
 * Per integration:
 *
 *   <INTEGRATION>_OPS_PG_CANONICAL  ("1" | unset/"0", default OFF)
 *     Polarity flip. When ON, that integration's operational
 *     repositories read & write Postgres instead of Mongo. Default OFF
 *     keeps Mongo canonical — zero behaviour change until an operator
 *     flips it (see docs/runbooks/mongo-cutover-sequence.md).
 *
 *   WRITE_MONGO_<INTEGRATION>_OPS   ("0" | unset/anything, default ON)
 *     Soak-window kill switch for the Mongo shadow write. Any value
 *     other than the literal string "0" leaves shadow writes enabled.
 *
 * Flags are read on every call, so flipping is a no-deploy env change,
 * reversible in <60s.
 */

function on(env: string | undefined): boolean {
  return env !== "0";
}

function canonical(env: string | undefined): boolean {
  return env === "1";
}

/* -------------------------------------------------------------------------- */
/* Tekmetric                                                                   */
/* -------------------------------------------------------------------------- */

export function isTekmetricOpsPgCanonical(): boolean {
  return canonical(process.env.TEKMETRIC_OPS_PG_CANONICAL);
}
export function shouldShadowWriteMongoTekmetricOps(): boolean {
  return on(process.env.WRITE_MONGO_TEKMETRIC_OPS);
}

/* -------------------------------------------------------------------------- */
/* Protractor                                                                  */
/* -------------------------------------------------------------------------- */

export function isProtractorOpsPgCanonical(): boolean {
  return canonical(process.env.PROTRACTOR_OPS_PG_CANONICAL);
}
export function shouldShadowWriteMongoProtractorOps(): boolean {
  return on(process.env.WRITE_MONGO_PROTRACTOR_OPS);
}

/* -------------------------------------------------------------------------- */
/* Shop-Ware                                                                   */
/* -------------------------------------------------------------------------- */

export function isShopwareOpsPgCanonical(): boolean {
  return canonical(process.env.SHOPWARE_OPS_PG_CANONICAL);
}
export function shouldShadowWriteMongoShopwareOps(): boolean {
  return on(process.env.WRITE_MONGO_SHOPWARE_OPS);
}

/* -------------------------------------------------------------------------- */
/* AutoVitals                                                                  */
/* -------------------------------------------------------------------------- */

export function isAutovitalsOpsPgCanonical(): boolean {
  return canonical(process.env.AUTOVITALS_OPS_PG_CANONICAL);
}
export function shouldShadowWriteMongoAutovitalsOps(): boolean {
  return on(process.env.WRITE_MONGO_AUTOVITALS_OPS);
}

/* -------------------------------------------------------------------------- */
/* Shared shadow-write wrapper                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Generic shadow-write wrapper, mirroring
 * `shadowWriteMongoIntegrationCache`. Calls `fn` iff `enabled()` is
 * true. Errors are logged but never thrown — once a store is
 * PG-canonical, Mongo is just a mirror, so a transient Mongo outage
 * must not break the cron/webhook/backfill path.
 */
export async function shadowWriteMongoIntegrationOps(
  enabled: () => boolean,
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  if (!enabled()) return;
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ShadowMongoOps] write failed (non-fatal) — ${label}: ${msg}`,
    );
  }
}
