// Repository for the `protractor_invoice_cache` collection.
//
// Per-shop, per-invoice cache of full `/Invoice/{id}` payloads. The
// backfill and onboarding pre-warm both populate this so subsequent
// Protractor reads can hit Mongo instead of paying per-invoice API cost.
// TTL is enforced at read time via `cachedAt`.
import type { Collection } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "protractor_invoice_cache";

export interface ProtractorInvoiceCacheDoc {
  shopId: number;
  invoiceId: string;
  invoice: any;
  cachedAt: Date;
}

async function collection(): Promise<Collection<ProtractorInvoiceCacheDoc>> {
  const db = await getDb();
  return db.collection<ProtractorInvoiceCacheDoc>(COLLECTION);
}

export async function findFreshInvoiceCacheEntry(
  shopId: number,
  invoiceId: string,
  ttlMs: number,
): Promise<ProtractorInvoiceCacheDoc | null> {
  const col = await collection();
  return col.findOne({
    shopId,
    invoiceId,
    cachedAt: { $gt: new Date(Date.now() - ttlMs) },
  });
}

/**
 * Async iterator over cached invoices (task #860 DVI-link sweep).
 * Projects only { shopId, invoice } to keep the cursor light.
 */
export async function* iterateInvoiceCacheEntries(
  shopId?: number,
): AsyncGenerator<Pick<ProtractorInvoiceCacheDoc, "shopId" | "invoice">> {
  const col = await collection();
  const filter = typeof shopId === "number" ? { shopId } : {};
  const cursor = col.find(filter, {
    projection: { shopId: 1, invoice: 1 },
  });
  for await (const doc of cursor) {
    yield doc as Pick<ProtractorInvoiceCacheDoc, "shopId" | "invoice">;
  }
}

export async function upsertInvoiceCacheEntry(
  shopId: number,
  invoiceId: string,
  invoice: any,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { shopId, invoiceId },
    {
      $set: { shopId, invoiceId, invoice, cachedAt: new Date() },
    },
    { upsert: true },
  );
}
