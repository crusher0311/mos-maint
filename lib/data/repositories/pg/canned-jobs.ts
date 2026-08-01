/**
 * Postgres-backed repository for the pre-normalized `canned_jobs` and
 * `canned_job_applications` Mongo collections (task #1000).
 *
 * Used by `lib/data/repositories/canned-jobs.ts` when
 * `CANNED_JOBS_PG_CANONICAL=1`. The full Mongo doc is stored verbatim in
 * the `payload` jsonb so the legacy doc shape survives the cutover; the
 * typed columns are denormalised copies that back the indexed lookups.
 *
 * `canned_jobs` is distinct from the protractor / tekmetric canned-job
 * *caches* — this store holds enriched canned-job docs keyed by
 * `(shopId, cannedJobId)`. Reads reconstruct the Mongo doc shape as
 * `{ ...payload }` so callers don't change (they read `title`/`name`/…).
 *
 * `canned_job_applications` is an append-only audit log; inserts mirror
 * the Mongo doc verbatim into `payload` with the indexed columns pulled
 * out.
 *
 * The PG-vs-Mongo dispatcher lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { cannedJobs, cannedJobApplications } from "@/lib/db/schema/wave3";

type AnyDoc = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* canned_jobs (enriched, per shop)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Returns every enriched canned job for a shop. Mirrors the Mongo query
 * `find({ shopId, enriched: true })`. The typed `payload` jsonb stores the
 * full doc, so the reconstruction returns the verbatim Mongo shape. Returns
 * `[]` when nothing matches — the empty-result semantics are preserved
 * exactly (no caching / no synthesised rows).
 */
export async function findEnrichedCannedJobs(
  shopId: number,
): Promise<AnyDoc[]> {
  const db = getDb();
  const rows = await db
    .select({ payload: cannedJobs.payload })
    .from(cannedJobs)
    .where(eq(cannedJobs.shopId, shopId));
  return rows
    .map((r) => (r.payload as AnyDoc) ?? {})
    .filter((doc) => (doc as AnyDoc).enriched === true);
}

/* -------------------------------------------------------------------------- */
/* canned_job_applications (append-only audit)                                 */
/* -------------------------------------------------------------------------- */

export interface CannedJobApplicationInsert {
  shopId?: number | string | null;
  cannedJobId?: unknown;
  vin?: string | null;
  roNumber?: string | null;
  appliedAt?: Date;
  /** Full original doc — stored verbatim in the payload jsonb. */
  [k: string]: unknown;
}

function toShopIdInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Appends a canned-job-application audit row. The full doc is stored in
 * `payload`; `shop_id`, `canned_job_id`, `vin`, `ro_number`, and
 * `applied_at` are pulled out for indexing.
 */
export async function insertCannedJobApplication(
  doc: CannedJobApplicationInsert,
): Promise<void> {
  const db = getDb();
  await db.insert(cannedJobApplications).values({
    shopId: toShopIdInt(doc.shopId),
    cannedJobId:
      doc.cannedJobId === null || doc.cannedJobId === undefined
        ? null
        : String(doc.cannedJobId),
    vin: (doc.vin as string | null) ?? null,
    roNumber: (doc.roNumber as string | null) ?? null,
    appliedAt: doc.appliedAt instanceof Date ? doc.appliedAt : new Date(),
    payload: doc as AnyDoc,
  } as typeof cannedJobApplications.$inferInsert);
}
