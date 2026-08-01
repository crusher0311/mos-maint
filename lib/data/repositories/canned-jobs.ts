// Repository for the pre-normalized `canned_jobs` and
// `canned_job_applications` Mongo collections (task #1000).
//
// `canned_jobs` holds enriched canned-job docs keyed by
// `(shopId, cannedJobId)`; the extension plan route reads them to attach
// full labor/parts detail to recommendations. This store is DISTINCT from
// the protractor / tekmetric canned-job *caches* — it must not introduce
// any caching of its own, and its empty-result semantics
// (`find(...).toArray()` returning `[]`) are preserved exactly.
//
// `canned_job_applications` is an append-only audit log written by the
// three apply-canned-job routes.
//
// Every public helper is gated on `isCannedJobsPgCanonical()`. When OFF
// (default), the original Mongo body runs verbatim (zero behaviour
// change). When ON, reads go to the Postgres mirror and writes go
// PG-first, then replay the Mongo write via
// `shadowWriteMongoLegacyStore` (only while the shadow flag is on).
import { getDb } from "@/lib/mongo";
import {
  isCannedJobsPgCanonical,
  shouldShadowWriteMongoCannedJobs,
  shadowWriteMongoLegacyStore,
} from "@/lib/db/legacy-store-write-mode";
import * as pg from "./pg/canned-jobs";

type AnyDoc = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* canned_jobs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Returns every enriched canned job for a shop
 * (`find({ shopId, enriched: true }).toArray()`). Empty result => `[]`.
 */
export async function findEnrichedCannedJobs(
  shopId: number | string,
): Promise<AnyDoc[]> {
  if (isCannedJobsPgCanonical()) {
    return pg.findEnrichedCannedJobs(Number(shopId));
  }
  return findEnrichedCannedJobsMongo(shopId);
}

async function findEnrichedCannedJobsMongo(
  shopId: number | string,
): Promise<AnyDoc[]> {
  const db = await getDb();
  return db
    .collection("canned_jobs")
    .find({ shopId, enriched: true })
    .toArray();
}

/* -------------------------------------------------------------------------- */
/* canned_job_applications (append-only audit)                                 */
/* -------------------------------------------------------------------------- */

/**
 * Appends a canned-job-application audit row. `doc` is the verbatim Mongo
 * doc the routes used to insert directly. When PG-canonical the row is
 * written to Postgres first, then shadow-written to Mongo.
 */
export async function insertCannedJobApplication(
  doc: Record<string, unknown>,
): Promise<void> {
  if (isCannedJobsPgCanonical()) {
    await pg.insertCannedJobApplication(doc);
    if (shouldShadowWriteMongoCannedJobs()) {
      await shadowWriteMongoLegacyStore("canned_job_applications.insert", () =>
        insertCannedJobApplicationMongo(doc),
      );
    }
    return;
  }
  await insertCannedJobApplicationMongo(doc);
}

async function insertCannedJobApplicationMongo(
  doc: Record<string, unknown>,
): Promise<void> {
  const db = await getDb();
  await db.collection("canned_job_applications").insertOne(doc);
}
