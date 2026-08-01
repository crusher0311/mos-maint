/**
 * Postgres-backed Protractor deferred-work store — the read & write
 * surface used by `lib/data/repositories/protractor-deferred-work.ts`
 * when `PROTRACTOR_OPS_PG_CANONICAL=1` (task #999).
 *
 * Backs the `protractor_deferred_work` mirror table
 * (lib/db/schema/wave3.ts). The Mongo doc keys on (shopId, VIN) with a
 * cached deferred-work `items` list and fetch metadata; the PG table's
 * PK is (shopId, deferredWorkId). We key each shop/VIN snapshot with a
 * synthetic `deferredWorkId = "vin:" + VIN` so the (shopId, vin) upsert
 * maps onto the composite PK, and stash the verbatim Mongo doc in the
 * `payload` jsonb so no field is lost on read-back.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag.
 */
import { and, count, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { protractorDeferredWork } from "@/lib/db/schema/wave3";
import type { ProtractorDeferredWorkDoc } from "../protractor-deferred-work";

// Synthetic per-VIN snapshot key so the (shopId, vin) Mongo upsert maps
// onto the wave3 (shopId, deferredWorkId) composite PK without collision.
function vinKey(vin: string): string {
  return `vin:${vin.toUpperCase()}`;
}

export async function findDeferredWorkByShopAndVin(
  shopId: number,
  vin: string,
): Promise<ProtractorDeferredWorkDoc | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(protractorDeferredWork)
    .where(
      and(
        eq(protractorDeferredWork.shopId, shopId),
        eq(protractorDeferredWork.deferredWorkId, vinKey(vin)),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  // Spread the verbatim Mongo doc back so callers see identical shape.
  return { ...(payload as ProtractorDeferredWorkDoc) };
}

export async function upsertDeferredWorkSnapshot(
  shopId: number,
  vin: string,
  items: unknown[],
  now: Date,
): Promise<void> {
  const db = getDb();
  const upper = vin.toUpperCase();
  const key = vinKey(vin);
  // Preserve the Mongo $setOnInsert(createdAt) semantic: createdAt is only
  // set on first insert and must not change on subsequent updates.
  const existing = await db
    .select({ payload: protractorDeferredWork.payload })
    .from(protractorDeferredWork)
    .where(
      and(
        eq(protractorDeferredWork.shopId, shopId),
        eq(protractorDeferredWork.deferredWorkId, key),
      ),
    )
    .limit(1);
  const priorCreatedAt =
    (existing[0]?.payload as Record<string, unknown> | undefined)?.createdAt ??
    now;
  const doc = {
    shopId,
    vin: upper,
    items,
    fetchedAt: now,
    source: "protractor",
    createdAt: priorCreatedAt,
  };
  await db
    .insert(protractorDeferredWork)
    .values({
      shopId,
      deferredWorkId: key,
      vin: upper,
      payload: doc,
      fetchedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        protractorDeferredWork.shopId,
        protractorDeferredWork.deferredWorkId,
      ],
      set: {
        vin: upper,
        payload: doc,
        fetchedAt: now,
      },
    });
}

export async function deleteDeferredWorkByShop(shopId: number): Promise<void> {
  const db = getDb();
  await db
    .delete(protractorDeferredWork)
    .where(eq(protractorDeferredWork.shopId, shopId));
}

export async function findDeferredWorkByShop(
  shopId: number,
): Promise<ProtractorDeferredWorkDoc[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(protractorDeferredWork)
    .where(eq(protractorDeferredWork.shopId, shopId));
  return rows.map((r) => ({
    ...((r.payload ?? {}) as ProtractorDeferredWorkDoc),
  }));
}

export async function countDeferredWorkByShop(shopId: number): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: count() })
    .from(protractorDeferredWork)
    .where(eq(protractorDeferredWork.shopId, shopId));
  return Number(rows[0]?.n ?? 0);
}
