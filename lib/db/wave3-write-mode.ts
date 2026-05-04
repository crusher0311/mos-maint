/**
 * Write-mode flags for the Wave 3b cutover (task #345).
 *
 * For each entity group we PG-canonical-flip in #345, the Mongo write
 * becomes an optional shadow gated on its own runtime kill-switch. The
 * flag is read on every write so toggling it is a no-deploy operation
 * (set to "0" to halt mirroring; unset to resume).
 *
 * Default during the soak window is ON (any value other than the
 * literal string "0" leaves shadow writes enabled). After each group's
 * 24–168 h soak passes, operators set the flag to "0" to retire the
 * Mongo mirror — see docs/db-migration-map.md §10.
 *
 * Per-integration mirror groups (Tekmetric / Protractor / Shopware /
 * Autoflow / Autovitals) ship their own flags in the per-group
 * cutover follow-up tasks (the schemas land in #345 but the polarity
 * flip is deferred). Adding a flag here is intentionally cheap so
 * each group can register its own kill switch without ceremony.
 */

function on(env: string | undefined): boolean {
  return env !== "0";
}

/** `counters` Mongo shadow during the W3b soak (default ON). */
export function shouldShadowWriteMongoCounters(): boolean {
  return on(process.env.WRITE_MONGO_COUNTERS);
}

/** `api_keys` + `api_usage_logs` Mongo shadow during the W3b soak. */
export function shouldShadowWriteMongoApiKeys(): boolean {
  return on(process.env.WRITE_MONGO_API_KEYS);
}

/** `events` Mongo shadow during the W3b soak. */
export function shouldShadowWriteMongoEvents(): boolean {
  return on(process.env.WRITE_MONGO_EVENTS);
}

/**
 * Generic shadow-write wrapper. Calls `fn` iff the flag is ON. Errors
 * are logged but never thrown — Mongo is no longer canonical, so a
 * transient Mongo outage must not break the request path.
 */
export async function shadowWriteMongo(
  flag: () => boolean,
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  if (!flag()) return;
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ShadowMongo] write failed (non-fatal) — ${label}: ${msg}`);
  }
}
