/**
 * Write-mode flags for the integration-cache cutover (task #556).
 *
 * The PG mirror tables for the five integration caches (Tekmetric /
 * Protractor / Shop-Ware / AutoFlow / AutoVitals) landed schema-only in
 * #345 (`drizzle/0014_wave3.sql`); the polarity flip was explicitly
 * deferred to this follow-up — see the header note in
 * `lib/db/wave3-write-mode.ts`.
 *
 * Each integration gets two runtime flags, read on every call so
 * toggling is a no-deploy operation (set/unset env, the next request
 * picks it up):
 *
 *   <INTEGRATION>_CACHE_PG_CANONICAL  ("1" | unset/"0", default OFF)
 *     The polarity flip. When ON, that integration's cache read & write
 *     helpers use Postgres instead of Mongo. Default OFF keeps Mongo
 *     canonical so behaviour is unchanged until an operator flips it
 *     during the announced soak — see
 *     docs/runbooks/db-integration-cache-cutover.md.
 *
 *   WRITE_MONGO_<INTEGRATION>_CACHE   ("0" | unset/anything, default ON)
 *     Soak-window kill switch for the optional Mongo shadow write that
 *     keeps the legacy collections in lock-step with Postgres for the
 *     24–168h post-flip safety window. Same polarity as the W3b/W4
 *     flags: any value other than the literal string "0" leaves shadow
 *     writes enabled. Operators flip this to "0" once the soak passes.
 *
 * The flags are intentionally per-integration so each cache group can
 * be flipped, soaked, and rolled back independently.
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

export function isTekmetricCachePgCanonical(): boolean {
  return canonical(process.env.TEKMETRIC_CACHE_PG_CANONICAL);
}
export function shouldShadowWriteMongoTekmetricCache(): boolean {
  return on(process.env.WRITE_MONGO_TEKMETRIC_CACHE);
}

/* -------------------------------------------------------------------------- */
/* Protractor                                                                  */
/* -------------------------------------------------------------------------- */

export function isProtractorCachePgCanonical(): boolean {
  return canonical(process.env.PROTRACTOR_CACHE_PG_CANONICAL);
}
export function shouldShadowWriteMongoProtractorCache(): boolean {
  return on(process.env.WRITE_MONGO_PROTRACTOR_CACHE);
}

/* -------------------------------------------------------------------------- */
/* Shop-Ware                                                                   */
/* -------------------------------------------------------------------------- */

export function isShopwareCachePgCanonical(): boolean {
  return canonical(process.env.SHOPWARE_CACHE_PG_CANONICAL);
}
export function shouldShadowWriteMongoShopwareCache(): boolean {
  return on(process.env.WRITE_MONGO_SHOPWARE_CACHE);
}

/* -------------------------------------------------------------------------- */
/* AutoFlow                                                                    */
/* -------------------------------------------------------------------------- */

export function isAutoflowCachePgCanonical(): boolean {
  return canonical(process.env.AUTOFLOW_CACHE_PG_CANONICAL);
}
export function shouldShadowWriteMongoAutoflowCache(): boolean {
  return on(process.env.WRITE_MONGO_AUTOFLOW_CACHE);
}

/* -------------------------------------------------------------------------- */
/* AutoVitals                                                                  */
/* -------------------------------------------------------------------------- */

export function isAutovitalsCachePgCanonical(): boolean {
  return canonical(process.env.AUTOVITALS_CACHE_PG_CANONICAL);
}
export function shouldShadowWriteMongoAutovitalsCache(): boolean {
  return on(process.env.WRITE_MONGO_AUTOVITALS_CACHE);
}

/* -------------------------------------------------------------------------- */
/* Shared shadow-write wrapper                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Generic shadow-write wrapper, mirroring `shadowWriteMongo` in
 * `wave3-write-mode.ts` and `shadowWriteMongoIdentity` in
 * `wave4-write-mode.ts`. Calls `fn` iff `enabled()` is true. Errors are
 * logged but never thrown — once an integration is PG-canonical, Mongo
 * is just a mirror, so a transient Mongo outage must not break the
 * request path.
 */
export async function shadowWriteMongoIntegrationCache(
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
      `[ShadowMongoCache] write failed (non-fatal) — ${label}: ${msg}`,
    );
  }
}
