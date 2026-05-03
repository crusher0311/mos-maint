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
