// Repository for the `protractor_invoices` collection.
//
// Cached Protractor invoice snapshots, keyed by (shopId, invoiceId).
// Distinct from `protractor_invoice_cache`: this collection stores the
// normalized snapshot view used by downstream readers, while the cache
// collection stores the raw per-id API payload with TTL semantics.
import type { Collection, Document } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "protractor_invoices";

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
