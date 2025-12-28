import { Db } from "mongodb";

const CACHE_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours

export interface CachedPlan {
  vin: string;
  shopId: number;
  plan: any;
  createdAt: Date;
  expiresAt: Date;
}

export async function getCachedPlan(db: Db, vin: string, shopId: number): Promise<CachedPlan | null> {
  const cached = await db.collection("cached_plans").findOne({
    vin: vin.toUpperCase(),
    shopId,
    expiresAt: { $gt: new Date() },
  });
  return cached as CachedPlan | null;
}

export async function setCachedPlan(db: Db, vin: string, shopId: number, plan: any): Promise<void> {
  const now = new Date();
  await db.collection("cached_plans").updateOne(
    { vin: vin.toUpperCase(), shopId },
    {
      $set: {
        plan,
        createdAt: now,
        expiresAt: new Date(now.getTime() + CACHE_TTL_MS),
      },
    },
    { upsert: true }
  );
}

export async function invalidateCachedPlan(db: Db, vin: string, shopId: number): Promise<void> {
  await db.collection("cached_plans").deleteOne({
    vin: vin.toUpperCase(),
    shopId,
  });
}

export async function checkAndTrackVin(
  db: Db, 
  shopId: number, 
  vin: string, 
  limit: number
): Promise<{ count: number; isNew: boolean; allowed: boolean }> {
  const normalizedVin = vin.toUpperCase();
  
  const existing = await db.collection("viewed_vins").findOne({ shopId, vin: normalizedVin });
  
  if (existing) {
    const count = await db.collection("viewed_vins").countDocuments({ shopId });
    await db.collection("viewed_vins").updateOne(
      { shopId, vin: normalizedVin },
      { $set: { lastViewedAt: new Date() }, $inc: { viewCount: 1 } }
    );
    return { count, isNew: false, allowed: true };
  }
  
  const count = await db.collection("viewed_vins").countDocuments({ shopId });
  
  if (count >= limit) {
    return { count, isNew: true, allowed: false };
  }
  
  const now = new Date();
  await db.collection("viewed_vins").insertOne({
    shopId,
    vin: normalizedVin,
    firstViewedAt: now,
    lastViewedAt: now,
    viewCount: 1,
  });
  
  return { count: count + 1, isNew: true, allowed: true };
}

export async function trackViewedVin(db: Db, shopId: number, vin: string): Promise<{ count: number; isNew: boolean }> {
  const now = new Date();
  const result = await db.collection("viewed_vins").updateOne(
    { shopId, vin: vin.toUpperCase() },
    {
      $setOnInsert: {
        firstViewedAt: now,
      },
      $set: {
        lastViewedAt: now,
      },
      $inc: { viewCount: 1 },
    },
    { upsert: true }
  );
  
  const isNew = result.upsertedCount > 0;
  
  const count = await db.collection("viewed_vins").countDocuments({ shopId });
  
  return { count, isNew };
}

export async function getViewedVinCount(db: Db, shopId: number): Promise<number> {
  return db.collection("viewed_vins").countDocuments({ shopId });
}

export async function hasViewedVin(db: Db, shopId: number, vin: string): Promise<boolean> {
  const doc = await db.collection("viewed_vins").findOne({ shopId, vin: vin.toUpperCase() });
  return doc !== null;
}
