// Repository for AutoFlow v4 shop-number management (task #884).
//
// AutoFlow's v4 UI (app.autoflow.com/shop/<number>/...) identifies shops by
// a number that often isn't stored on any shop doc. Extension lookups fail
// CLOSED on such misses and record them in `autoflow_unresolved_numbers`;
// a platform admin reviews them and attaches each number to the right
// shop's `autoflow.shopNumbers`.
import { getDb } from "@/lib/data/db";

const UNRESOLVED_COLLECTION = "autoflow_unresolved_numbers";

export interface UnresolvedAutoflowNumberDoc {
  number: string;
  firstSeenAt?: Date | null;
  lastSeenAt?: Date | null;
  seenCount?: number;
  candidateShopIds?: (string | number)[];
  candidateCount?: number;
  resolvedShopId?: string | number | null;
  resolvedAt?: Date | null;
  resolvedBy?: string | null;
}

export interface AutoflowShopSummary {
  shopId: string | number;
  name: string;
  autoflowDomain: string | null;
  shopNumbers: string[];
}

export async function listUnresolvedAutoflowNumbers(
  limit = 200,
): Promise<UnresolvedAutoflowNumberDoc[]> {
  const db = await getDb();
  return db
    .collection(UNRESOLVED_COLLECTION)
    .find({ resolvedShopId: null })
    .sort({ lastSeenAt: -1 })
    .limit(limit)
    .toArray() as unknown as Promise<UnresolvedAutoflowNumberDoc[]>;
}

// AutoFlow-connected shops (attach targets) + shops already carrying v4
// numbers (current mappings).
export async function listAutoflowShops(): Promise<AutoflowShopSummary[]> {
  const db = await getDb();
  const shops = await db
    .collection("shops")
    .find(
      {
        $or: [
          { "autoflow.domain": { $exists: true } },
          { "autoflow.subdomain": { $exists: true } },
          { "autoflow.shopId": { $exists: true } },
          { "autoflow.configured": true },
          { "autoflow.shopNumbers.0": { $exists: true } },
          { autoflowDomain: { $exists: true } },
        ],
      },
      {
        projection: {
          shopId: 1,
          name: 1,
          "autoflow.domain": 1,
          "autoflow.subdomain": 1,
          "autoflow.shopNumbers": 1,
          autoflowDomain: 1,
        },
      },
    )
    .sort({ name: 1 })
    .toArray();
  return shops.map((s: any) => ({
    shopId: s.shopId,
    name: s.name || `Shop ${s.shopId}`,
    autoflowDomain:
      s.autoflow?.domain || s.autoflowDomain || s.autoflow?.subdomain || null,
    shopNumbers: s.autoflow?.shopNumbers || [],
  }));
}

export async function findShopByIdBasic(shopId: string | number) {
  const db = await getDb();
  return db.collection("shops").findOne(
    { shopId },
    { projection: { shopId: 1, name: 1, autoflow: 1, autoflowDomain: 1 } },
  );
}

// Guard helper: a v4 number may only be attached to ONE shop.
export async function findShopWithAutoflowNumberConflict(
  number: string,
  excludeShopId: string | number,
) {
  const db = await getDb();
  return db.collection("shops").findOne(
    { "autoflow.shopNumbers": number, shopId: { $ne: excludeShopId } },
    { projection: { shopId: 1, name: 1 } },
  );
}

export async function attachAutoflowNumber(
  shopId: string | number,
  number: string,
  resolvedBy: string | null,
): Promise<void> {
  const db = await getDb();
  await db.collection("shops").updateOne(
    { shopId },
    { $addToSet: { "autoflow.shopNumbers": number } },
  );
  await db.collection(UNRESOLVED_COLLECTION).updateOne(
    { number },
    { $set: { resolvedShopId: shopId, resolvedAt: new Date(), resolvedBy } },
  );
}

export async function detachAutoflowNumber(
  shopId: string | number,
  number: string,
): Promise<void> {
  const db = await getDb();
  await db.collection("shops").updateOne(
    { shopId },
    { $pull: { "autoflow.shopNumbers": number } } as any,
  );
  // Re-open the unresolved entry so the number is visible again if the
  // extension keeps hitting it.
  await db.collection(UNRESOLVED_COLLECTION).updateOne(
    { number },
    { $set: { resolvedShopId: null, resolvedAt: null } },
  );
}
