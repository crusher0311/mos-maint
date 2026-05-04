/**
 * Write-mode flag for the normalized-ingestion polarity flip (task #344, W3a).
 *
 * After the W3a flip, Postgres is the canonical store for the six
 * normalized entities (vehicles, customers, work_orders, service_jobs,
 * line_items, payments). Mongo writes become an optional shadow mirror
 * gated on this flag.
 *
 * Default during the soak window is ON (`WRITE_MONGO_NORMALIZED` unset
 * or anything other than the literal string "0" leaves shadow writes
 * enabled). Operators flip it to "0" after the per-entity 24–168 h soak
 * passes — see docs/db-migration-map.md §10.
 *
 * The flag is read on **every** write so it is a runtime kill-switch:
 * setting it without a deploy is sufficient to stop or resume the
 * Mongo mirror.
 */
export function shouldShadowWriteMongo(): boolean {
  return process.env.WRITE_MONGO_NORMALIZED !== "0";
}
