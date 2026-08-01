/**
 * Postgres-backed AutoVitals OPERATIONAL repository (task #999).
 *
 * Backs the `autovitals_imports` table (lib/db/schema/wave3.ts), the PG
 * twin of the Mongo `autovitals_imports` collection — a per-run import
 * log written by the browser-extension vehicle sync. Kept in its own
 * file (rather than the shared `pg/autovitals-cache.ts`) so the cache
 * cutover and this operational store stay decoupled.
 *
 * Every insert stashes the verbatim source document in `payload` so no
 * field is lost; the typed columns (`shopId`, `importType`, `startedAt`,
 * `finishedAt`, `success`, `summary`) are projected for indexed access.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag.
 */
import { getDb } from "@/lib/db/drizzle";
import { autovitalsImports } from "@/lib/db/schema/wave3";

type AnyDoc = Record<string, unknown>;

/**
 * Insert one import-log row. Mirrors Mongo `insertOne` — the whole doc
 * is preserved in `payload` and the few typed columns are mapped from
 * well-known keys when present.
 */
export async function insertAutoVitalsImport(doc: AnyDoc): Promise<void> {
  const db = getDb();
  const startedAt =
    doc.syncedAt instanceof Date
      ? (doc.syncedAt as Date)
      : typeof doc.syncedAt === "string"
        ? new Date(doc.syncedAt as string)
        : null;
  await db.insert(autovitalsImports).values({
    shopId: doc.shopId === undefined || doc.shopId === null
      ? null
      : String(doc.shopId),
    importType:
      typeof doc.source === "string" ? (doc.source as string) : null,
    startedAt,
    payload: doc,
  } as typeof autovitalsImports.$inferInsert);
}
