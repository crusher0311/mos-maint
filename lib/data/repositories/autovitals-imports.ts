// Repository for the `autovitals_imports` collection (task #999).
//
// A per-run import log written by the AutoVitals browser-extension
// vehicle sync (`app/api/autovitals/extension/sync-vehicles/route.ts`).
//
// For consistency with its cache siblings (`autovitals-appointments`,
// `autovitals-inspections`), this store is gated on the AutoVitals CACHE
// flag from `lib/db/integration-cache-write-mode.ts`. When PG-canonical
// we write Postgres (via `./pg/autovitals-ops`) and shadow-write Mongo
// behind the cache kill-switch. Default OFF keeps Mongo canonical and
// byte-identical to pre-cutover behavior.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  isAutovitalsCachePgCanonical,
  shouldShadowWriteMongoAutovitalsCache,
  shadowWriteMongoIntegrationCache,
} from "@/lib/db/integration-cache-write-mode";
import * as pg from "./pg/autovitals-ops";

const COLLECTION = "autovitals_imports";

export interface AutoVitalsImportDoc {
  shopId?: unknown;
  source?: string;
  pageUrl?: string;
  vehiclesReceived?: number;
  vehiclesImported?: number;
  vehiclesUpdated?: number;
  vehiclesSkipped?: number;
  extractedAt?: Date;
  syncedAt?: Date;
  [k: string]: unknown;
}

async function collection(): Promise<Collection<Document>> {
  const db = await getDb();
  return db.collection<Document>(COLLECTION);
}

/** Insert one import-log row (Mongo `insertOne`). */
export async function insertAutoVitalsImport(
  doc: AutoVitalsImportDoc,
): Promise<void> {
  if (isAutovitalsCachePgCanonical()) {
    await pg.insertAutoVitalsImport(doc as Record<string, unknown>);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoAutovitalsCache,
      "autovitals.imports.insert",
      () => insertAutoVitalsImportMongo(doc),
    );
    return;
  }
  await insertAutoVitalsImportMongo(doc);
}

async function insertAutoVitalsImportMongo(
  doc: AutoVitalsImportDoc,
): Promise<void> {
  const col = await collection();
  await col.insertOne({ ...doc });
}
