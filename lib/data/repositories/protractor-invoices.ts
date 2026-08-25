// Repository for the `protractor_invoices` collection.
//
// Cached Protractor invoice snapshots, keyed by (shopId, invoiceId).
// Distinct from `protractor_invoice_cache`: this collection stores the
// normalized snapshot view used by downstream readers, while the cache
// collection stores the raw per-id API payload with TTL semantics.
import type { Collection, Document, Filter } from "mongodb";
import { getDb } from "@/lib/data/db";
import { isProtractorCachePgCanonical } from "@/lib/db/integration-cache-write-mode";
import * as pg from "./pg/protractor-cache";

const COLLECTION = "protractor_invoices";
const MAX_BATCH_LOOKUP_IDS = 600;

export interface ProtractorInvoiceSnapshotDoc extends Document {
  shopId: number;
  invoiceId: string;
  invoiceNumber?: number | null;
  invoiceDate?: string | null;
  vin?: string | null;
  serviceItemId?: string | null;
  contactId?: string | null;
  odometer?: number | null;
  total?: number | null;
  servicePackages?: any[];
  fetchedAt?: Date;
  source?: string;
  rawPayload?: any;
  createdAt?: Date;
}

async function collection(): Promise<Collection<ProtractorInvoiceSnapshotDoc>> {
  const db = await getDb();
  return db.collection<ProtractorInvoiceSnapshotDoc>(COLLECTION);
}

export type ProtractorInvoiceUpsertFields = Partial<
  Omit<ProtractorInvoiceSnapshotDoc, "createdAt">
>;

export async function upsertInvoiceSnapshot(
  shopId: number,
  invoiceId: string,
  set: ProtractorInvoiceUpsertFields,
  now: Date,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId, invoiceId },
    { $set: set, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
}

/** Bounded, cache-only invoice lookup for the Missed Opportunities report. */
export async function findCachedInvoiceSnapshotsByIds(
  shopId: number,
  invoiceIds: string[],
): Promise<ProtractorInvoiceSnapshotDoc[]> {
  const ids = Array.from(
    new Set(invoiceIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ).slice(0, MAX_BATCH_LOOKUP_IDS);
  if (ids.length === 0) return [];
  if (isProtractorCachePgCanonical()) {
    const canonical = (await pg.findCachedInvoiceSnapshotsByIds(
      shopId,
      ids,
    )) as ProtractorInvoiceSnapshotDoc[];
    const found = new Set(canonical.map((doc) => String(doc.invoiceId)));
    const missingIds = ids.filter((id) => !found.has(id));
    if (missingIds.length === 0) return canonical;
    // Invoice snapshot writers have not fully moved to PG yet. Read only the
    // missing identities from Mongo so newly cached terminal invoices remain
    // usable without weakening PG-first behavior for rows that exist there.
    return [
      ...canonical,
      ...(await findInvoiceSnapshotsByIdsMongo(shopId, missingIds)),
    ];
  }
  return findInvoiceSnapshotsByIdsMongo(shopId, ids);
}

async function findInvoiceSnapshotsByIdsMongo(
  shopId: number,
  ids: string[],
): Promise<ProtractorInvoiceSnapshotDoc[]> {
  const col = await collection();
  return col
    .find({
      shopId,
      invoiceId: { $in: ids },
    } as Filter<ProtractorInvoiceSnapshotDoc>)
    .sort({ fetchedAt: -1 })
    .toArray();
}
