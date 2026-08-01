/**
 * Postgres-backed Protractor service-item (vehicle-by-service-item)
 * cache — the read & write surface used by
 * `lib/data/repositories/protractor-service-items.ts` when
 * `PROTRACTOR_OPS_PG_CANONICAL=1` (task #999).
 *
 * Backs the `protractor_service_items` mirror table
 * (lib/db/schema/wave3.ts, PK (shopId, serviceItemId)). The Mongo doc
 * carries the decoded vehicle fields (vin/year/make/model/engine) plus
 * fetch metadata; the typed vin column is mirrored for the shop/vin index
 * and the verbatim doc is stashed in the `payload` jsonb so no field is
 * lost on read-back.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag.
 */
import { and, count, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { protractorServiceItems } from "@/lib/db/schema/wave3";
import type { ProtractorServiceItemDoc } from "../protractor-service-items";

export async function findServiceItem(
  shopId: number,
  serviceItemId: string,
): Promise<ProtractorServiceItemDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(protractorServiceItems)
    .where(
      and(
        eq(protractorServiceItems.shopId, shopId),
        eq(protractorServiceItems.serviceItemId, serviceItemId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const payload = (row.payload ?? {}) as ProtractorServiceItemDoc;
  return { ...payload };
}

export async function upsertServiceItem(
  shopId: number,
  serviceItemId: string,
  data: ProtractorServiceItemDoc,
): Promise<void> {
  const db = getDb();
  await db
    .insert(protractorServiceItems)
    .values({
      shopId,
      serviceItemId,
      vin: data.vin ?? null,
      payload: data,
      fetchedAt: data.fetchedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [
        protractorServiceItems.shopId,
        protractorServiceItems.serviceItemId,
      ],
      set: {
        vin: data.vin ?? null,
        payload: data,
        fetchedAt: data.fetchedAt ?? new Date(),
      },
    });
}

export async function countServiceItemsByShop(shopId: number): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: count() })
    .from(protractorServiceItems)
    .where(eq(protractorServiceItems.shopId, shopId));
  return Number(rows[0]?.n ?? 0);
}
