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
  limit: number,
  roId?: string | null
): Promise<{ count: number; isNew: boolean; allowed: boolean }> {
  const normalizedVin = vin.toUpperCase();
  const normalizedRoNumber = roId?.trim() || null;
  
  // Track by VIN + RO combination - each visit counts as a new view
  // Use roNumber to match the existing MongoDB index (shopId_vin_roNumber)
  const query: any = { shopId, vin: normalizedVin, roNumber: normalizedRoNumber };
  
  const existing = await db.collection("viewed_vins").findOne(query);
  
  if (existing) {
    // Same VIN + RO already viewed - doesn't count again
    const count = await db.collection("viewed_vins").countDocuments({ shopId });
    await db.collection("viewed_vins").updateOne(
      query,
      { $set: { lastViewedAt: new Date() }, $inc: { viewCount: 1 } }
    );
    return { count, isNew: false, allowed: true };
  }
  
  // New VIN + RO combination - counts as a new view
  const count = await db.collection("viewed_vins").countDocuments({ shopId });
  
  if (count >= limit) {
    return { count, isNew: true, allowed: false };
  }
  
  const now = new Date();
  
  try {
    await db.collection("viewed_vins").insertOne({
      shopId,
      vin: normalizedVin,
      roNumber: normalizedRoNumber,
      firstViewedAt: now,
      lastViewedAt: now,
      viewCount: 1,
    });
    return { count: count + 1, isNew: true, allowed: true };
  } catch (err: any) {
    // Handle duplicate key error gracefully (race condition or null roNumber conflict)
    if (err.code === 11000) {
      // Already exists - just update and return as existing
      await db.collection("viewed_vins").updateOne(
        query,
        { $set: { lastViewedAt: now }, $inc: { viewCount: 1 } }
      );
      const updatedCount = await db.collection("viewed_vins").countDocuments({ shopId });
      return { count: updatedCount, isNew: false, allowed: true };
    }
    throw err;
  }
}

export async function trackViewedVin(db: Db, shopId: number, vin: string, roId?: string | null): Promise<{ count: number; isNew: boolean }> {
  const now = new Date();
  const normalizedVin = vin.toUpperCase();
  const normalizedRoNumber = roId?.trim() || null;
  
  // Use roNumber to match the existing MongoDB index (shopId_vin_roNumber)
  const query: any = { shopId, vin: normalizedVin, roNumber: normalizedRoNumber };
  
  try {
    const result = await db.collection("viewed_vins").updateOne(
      query,
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
  } catch (err: any) {
    // Handle duplicate key error gracefully
    if (err.code === 11000) {
      await db.collection("viewed_vins").updateOne(
        query,
        { $set: { lastViewedAt: now }, $inc: { viewCount: 1 } }
      );
      const count = await db.collection("viewed_vins").countDocuments({ shopId });
      return { count, isNew: false };
    }
    throw err;
  }
}

export async function getViewedVinCount(db: Db, shopId: number): Promise<number> {
  return db.collection("viewed_vins").countDocuments({ shopId });
}

export async function hasViewedVin(db: Db, shopId: number, vin: string): Promise<boolean> {
  const doc = await db.collection("viewed_vins").findOne({ shopId, vin: vin.toUpperCase() });
  return doc !== null;
}
