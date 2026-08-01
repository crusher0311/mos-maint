/**
 * Write-mode flags for the legacy pre-normalized store cutover (task #1000).
 *
 * Covers the last data-bearing Mongo group before decommission: the
 * VIN-keyed `vehicles` / `customers` / `manual_vehicles` stores, the DVI
 * advisory stores (`dvi`, `dvi_results`), canned jobs
 * (`canned_jobs`, `canned_job_applications`), `concern_conversations`,
 * `shop_repair_patterns`, and `support_tickets`.
 *
 * Same conventions as `lib/db/integration-cache-write-mode.ts` (task #556):
 *
 *   <DOMAIN>_PG_CANONICAL  ("1" | unset/"0", default OFF)
 *     Polarity flip. When ON, that domain's gated repository reads/writes
 *     Postgres instead of Mongo. Default OFF => Mongo canonical => zero
 *     behaviour change until an operator flips it during a soak.
 *
 *   WRITE_MONGO_<DOMAIN>   ("0" | unset/anything, default ON)
 *     Post-flip Mongo shadow-write kill switch. Any value other than the
 *     literal "0" keeps shadow writes on.
 *
 * Flags are read on every call — no-deploy toggles. Flipping them and
 * running backfills is operator-only (dev Mongo == prod Mongo).
 */

function on(env: string | undefined): boolean {
  return env !== "0";
}

function canonical(env: string | undefined): boolean {
  return env === "1";
}

/* vehicles / customers / manual_vehicles (pre-normalized identity stores) */
export function isLegacyVehiclesPgCanonical(): boolean {
  return canonical(process.env.LEGACY_VEHICLES_PG_CANONICAL);
}
export function shouldShadowWriteMongoLegacyVehicles(): boolean {
  return on(process.env.WRITE_MONGO_LEGACY_VEHICLES);
}

/* dvi + dvi_results (advisory-only DVI stores) */
export function isDviPgCanonical(): boolean {
  return canonical(process.env.DVI_PG_CANONICAL);
}
export function shouldShadowWriteMongoDvi(): boolean {
  return on(process.env.WRITE_MONGO_DVI);
}

/* canned_jobs + canned_job_applications */
export function isCannedJobsPgCanonical(): boolean {
  return canonical(process.env.CANNED_JOBS_PG_CANONICAL);
}
export function shouldShadowWriteMongoCannedJobs(): boolean {
  return on(process.env.WRITE_MONGO_CANNED_JOBS);
}

/* concern_conversations */
export function isConcernConversationsPgCanonical(): boolean {
  return canonical(process.env.CONCERN_CONVERSATIONS_PG_CANONICAL);
}
export function shouldShadowWriteMongoConcernConversations(): boolean {
  return on(process.env.WRITE_MONGO_CONCERN_CONVERSATIONS);
}

/* shop_repair_patterns */
export function isRepairPatternsPgCanonical(): boolean {
  return canonical(process.env.REPAIR_PATTERNS_PG_CANONICAL);
}
export function shouldShadowWriteMongoRepairPatterns(): boolean {
  return on(process.env.WRITE_MONGO_REPAIR_PATTERNS);
}

/* support_tickets */
export function isSupportTicketsPgCanonical(): boolean {
  return canonical(process.env.SUPPORT_TICKETS_PG_CANONICAL);
}
export function shouldShadowWriteMongoSupportTickets(): boolean {
  return on(process.env.WRITE_MONGO_SUPPORT_TICKETS);
}

/**
 * Fire-and-forget Mongo shadow write used by the gated repos while a
 * domain is PG-canonical and its shadow flag is still on. Never throws —
 * a Mongo outage must not break a PG-canonical path.
 */
export async function shadowWriteMongoLegacyStore(
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[ShadowMongoLegacyStore] ${label} failed:`, err);
  }
}
