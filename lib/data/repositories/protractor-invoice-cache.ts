// Repository for the `protractor_invoice_cache` collection.
//
// Per-shop, per-invoice cache of full `/Invoice/{id}` payloads. The
// backfill and onboarding pre-warm both populate this so subsequent
// Protractor reads can hit Mongo instead of paying per-invoice API cost.
// TTL is enforced at read time via `cachedAt`.
import type { Collection, Filter } from "mongodb";
import { getDb } from "@/lib/data/db";
import { isProtractorCachePgCanonical } from "@/lib/db/integration-cache-write-mode";
import * as pg from "./pg/protractor-cache";

const COLLECTION = "protractor_invoice_cache";
const MAX_BATCH_LOOKUP_IDS = 600;

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
 * Bounded raw-invoice lookup. Report generation intentionally accepts stale
 * entries because it is reconstructing a historical closed ticket, not using
 * the payload as a live provider view.
 */
export async function findInvoiceCacheEntriesByIds(
  shopId: number,
  invoiceIds: string[],
  options: { maxTimeMS?: number } = {},
): Promise<ProtractorInvoiceCacheDoc[]> {
  const ids = Array.from(
    new Set(invoiceIds.map((id) => String(id || "").trim()).filter(Boolean)),
  ).slice(0, MAX_BATCH_LOOKUP_IDS);
  if (ids.length === 0) return [];
  if (isProtractorCachePgCanonical()) {
    const canonical = (await pg.findInvoiceCacheEntriesByIds(
      shopId,
      ids,
      options,
    )) as unknown as ProtractorInvoiceCacheDoc[];
    const found = new Set(canonical.map((doc) => String(doc.invoiceId)));
    const missingIds = ids.filter((id) => !found.has(id));
    if (missingIds.length === 0) return canonical;
    // Raw invoice-cache writers are still partly Mongo-backed. Fill only PG
    // misses so a fresh cached invoice is not hidden by the read cutover.
    return [
      ...canonical,
      ...(await findInvoiceCacheEntriesByIdsMongo(shopId, missingIds, options)),
    ];
  }
  return findInvoiceCacheEntriesByIdsMongo(shopId, ids, options);
}

async function findInvoiceCacheEntriesByIdsMongo(
  shopId: number,
  ids: string[],
  options: { maxTimeMS?: number } = {},
): Promise<ProtractorInvoiceCacheDoc[]> {
  const col = await collection();
  return col
    .find(
      {
        shopId,
        invoiceId: { $in: ids },
      } as Filter<ProtractorInvoiceCacheDoc>,
      { maxTimeMS: options.maxTimeMS },
    )
    .sort({ cachedAt: -1 })
    .toArray();
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
