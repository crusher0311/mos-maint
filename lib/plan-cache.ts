import sql from "@/lib/db/postgres";

const CACHE_TTL_MS = 1000 * 60 * 60 * 4; // 4 hours
const MILEAGE_TOLERANCE = 500; // Plans are still valid within 500 miles

export interface DeclinedServiceCache {
  serviceKey: string;
  serviceName: string;
  mileage?: number | null;
  reason?: string | null;
  declinedAt: string;
}

export interface TriagedItemCache {
  key: string;
  serviceKey: string;
  title: string;
  category?: string;
  intervalMiles?: number | null;
  intervalMonths?: number | null;
  last?: { miles?: number | null; date?: string | null; source?: string };
  dueAtMiles?: number | null;
  dueAtDate?: string | null;
  milesToGo?: number | null;
  daysToGo?: number | null;
  bump?: "red" | "yellow" | null;
  source?: "oem" | "dvi" | "protractor";
  dviSource?: "autoflow" | "autovitals";
  reason?: string;
  usingShopInterval?: boolean;
  protractorDeferredId?: string;
  matchedDeferred?: { id: string; title: string };
  declined?: DeclinedServiceCache | null;
}

export interface CachedDeferredWork {
  ID?: string;
  ServiceItemID?: string;
  Title?: string;
  Description?: string;
}

export interface CachedPlanData {
  buckets: {
    overdue: TriagedItemCache[];
    dueSoon: TriagedItemCache[];
    upcoming: TriagedItemCache[];
  };
  vehicle: {
    year?: number | null;
    make?: string | null;
    model?: string | null;
    engine?: string | null;
  };
  currentMiles: number | null;
  mpdBlended: number | null;
  customerName: string | null;
  latestRoNumber: string | null;
  distanceUnit: "miles" | "kilometers";
  soonMiles: number;
  soonDays: number;
  showInspectItems: boolean;
  deferredWork?: CachedDeferredWork[];
}

export interface CachedPlan {
  vin: string;
  shopId: number;
  mileage: number | null;
  plan: CachedPlanData;
  createdAt: Date;
  expiresAt: Date;
}

export async function getCachedPlan(
  vin: string, 
  shopId: number, 
  currentMiles?: number | null
): Promise<CachedPlan | null> {
  const shopIdStr = String(shopId);
  const normalizedVin = vin.toUpperCase();
  
  const rows = await sql`
    SELECT cp.vin, cp.mileage, cp.plan_data, cp.created_at, cp.expires_at
    FROM cached_plans cp
    JOIN shops s ON cp.shop_id = s.id
    WHERE s.shop_id = ${shopIdStr}
      AND cp.vin = ${normalizedVin}
    LIMIT 1
  `;
  
  const anyEntry = rows[0];
  if (!anyEntry) {
    console.log(`[PlanCache] MISS: No cache entry for ${vin}`);
    return null;
  }
  
  const expiresAt = new Date(anyEntry.expires_at as string);
  const createdAt = new Date(anyEntry.created_at as string);
  const cachedMileage = anyEntry.mileage as number | null;
  
  if (expiresAt <= new Date()) {
    const ageMinutes = Math.round((Date.now() - expiresAt.getTime()) / 60000);
    console.log(`[PlanCache] MISS: Expired ${ageMinutes}m ago for ${vin}`);
    return null;
  }
  
  if (currentMiles != null && cachedMileage != null) {
    const mileageDiff = Math.abs(currentMiles - cachedMileage);
    if (mileageDiff > MILEAGE_TOLERANCE) {
      console.log(`[PlanCache] MISS: Mileage changed ${cachedMileage} -> ${currentMiles} (diff: ${mileageDiff}) for ${vin}`);
      return null;
    }
  }
  
  const ageMinutes = Math.round((Date.now() - createdAt.getTime()) / 60000);
  console.log(`[PlanCache] HIT: ${vin} cached ${ageMinutes}m ago, ${cachedMileage} miles`);
  
  return {
    vin: normalizedVin,
    shopId,
    mileage: cachedMileage,
    plan: anyEntry.plan_data as CachedPlanData,
    createdAt,
    expiresAt,
  };
}

export async function setCachedPlan(
  vin: string, 
  shopId: number, 
  mileage: number | null,
  plan: CachedPlanData
): Promise<void> {
  const shopIdStr = String(shopId);
  const normalizedVin = vin.toUpperCase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);
  const cacheKey = `${shopIdStr}:${normalizedVin}`;
  
  await sql`
    INSERT INTO cached_plans (cache_key, shop_id, vin, mileage, plan_data, created_at, expires_at)
    SELECT 
      ${cacheKey},
      s.id,
      ${normalizedVin},
      ${mileage},
      ${JSON.stringify(plan)}::jsonb,
      ${now},
      ${expiresAt}
    FROM shops s
    WHERE s.shop_id = ${shopIdStr}
    ON CONFLICT (cache_key) DO UPDATE SET
      mileage = EXCLUDED.mileage,
      plan_data = EXCLUDED.plan_data,
      created_at = EXCLUDED.created_at,
      expires_at = EXCLUDED.expires_at
  `;
  
  console.log(`[PlanCache] Cached plan for ${vin} at ${mileage} miles, TTL 4h`);
}

export async function invalidateCachedPlan(vin: string, shopId: number): Promise<void> {
  const shopIdStr = String(shopId);
  const normalizedVin = vin.toUpperCase();
  
  await sql`
    DELETE FROM cached_plans
    WHERE shop_id = (SELECT id FROM shops WHERE shop_id = ${shopIdStr} LIMIT 1)
      AND vin = ${normalizedVin}
  `;
}

export async function updateCachedPlanMileage(
  vin: string,
  shopId: number,
  newMileage: number,
  mpdBlended?: number | null
): Promise<{ updated: boolean; crossedInterval: boolean }> {
  const shopIdStr = String(shopId);
  const normalizedVin = vin.toUpperCase();
  
  const rows = await sql`
    SELECT cp.id, cp.mileage, cp.plan_data, cp.created_at, cp.expires_at
    FROM cached_plans cp
    JOIN shops s ON cp.shop_id = s.id
    WHERE s.shop_id = ${shopIdStr}
      AND cp.vin = ${normalizedVin}
    LIMIT 1
  `;
  
  if (!rows[0]) {
    return { updated: false, crossedInterval: false };
  }
  
  const cached = rows[0] as any;
  const cachedMileage = cached.mileage as number | null;
  const planData = cached.plan_data as CachedPlanData;
  const expiresAt = new Date(cached.expires_at as string);
  
  if (expiresAt <= new Date()) {
    return { updated: false, crossedInterval: false };
  }
  
  if (cachedMileage == null || newMileage == null) {
    return { updated: false, crossedInterval: false };
  }
  
  const milesDriven = newMileage - cachedMileage;
  if (milesDriven <= 0) {
    return { updated: false, crossedInterval: false };
  }
  
  const avgMpd = mpdBlended || planData.mpdBlended || 30;
  const daysDriven = Math.round(milesDriven / avgMpd);
  
  let crossedInterval = false;
  
  const updateBucket = (items: TriagedItemCache[]): TriagedItemCache[] => {
    return items.map(item => {
      const updated = { ...item };
      
      if (updated.milesToGo != null) {
        updated.milesToGo = updated.milesToGo - milesDriven;
        if (updated.milesToGo <= 0 && item.milesToGo! > 0) {
          crossedInterval = true;
        }
      }
      
      if (updated.daysToGo != null) {
        updated.daysToGo = updated.daysToGo - daysDriven;
      }
      
      if (updated.dueAtMiles != null) {
        const newMilesToGo = updated.dueAtMiles - newMileage;
        if (newMilesToGo <= 0 && (item.milesToGo ?? 0) > 0) {
          crossedInterval = true;
        }
      }
      
      return updated;
    });
  };
  
  const updatedPlan: CachedPlanData = {
    ...planData,
    currentMiles: newMileage,
    mpdBlended: mpdBlended ?? planData.mpdBlended,
    buckets: {
      overdue: updateBucket(planData.buckets.overdue),
      dueSoon: updateBucket(planData.buckets.dueSoon),
      upcoming: updateBucket(planData.buckets.upcoming),
    },
  };
  
  if (crossedInterval) {
    console.log(`[PlanCache] Interval crossed for ${vin}, invalidating cache`);
    await invalidateCachedPlan(vin, shopId);
    return { updated: false, crossedInterval: true };
  }
  
  await sql`
    UPDATE cached_plans
    SET mileage = ${newMileage},
        plan_data = ${JSON.stringify(updatedPlan)}::jsonb
    WHERE id = ${cached.id}
  `;
  
  console.log(`[PlanCache] Delta update for ${vin}: ${cachedMileage} -> ${newMileage} miles (+${milesDriven})`);
  return { updated: true, crossedInterval: false };
}

export async function checkAndTrackVin(
  shopId: number, 
  vin: string, 
  limit: number,
  roId?: string | null
): Promise<{ count: number; isNew: boolean; allowed: boolean }> {
  const shopIdStr = String(shopId);
  const normalizedVin = vin.toUpperCase();
  const normalizedRoNumber = roId?.trim() || null;
  
  const existingRows = await sql`
    SELECT vv.id
    FROM viewed_vins vv
    JOIN shops s ON vv.shop_id = s.id
    WHERE s.shop_id = ${shopIdStr}
      AND vv.vin = ${normalizedVin}
      AND (
        (vv.ro_number IS NULL AND ${normalizedRoNumber}::text IS NULL)
        OR vv.ro_number = ${normalizedRoNumber}
      )
    LIMIT 1
  `;
  
  if (existingRows.length > 0) {
    const countRows = await sql`
      SELECT COUNT(*) as count
      FROM viewed_vins vv
      JOIN shops s ON vv.shop_id = s.id
      WHERE s.shop_id = ${shopIdStr}
    `;
    const count = Number(countRows[0]?.count || 0);
    
    await sql`
      UPDATE viewed_vins
      SET viewed_at = NOW()
      WHERE id = ${existingRows[0].id}
    `;
    
    return { count, isNew: false, allowed: true };
  }
  
  const countRows = await sql`
    SELECT COUNT(*) as count
    FROM viewed_vins vv
    JOIN shops s ON vv.shop_id = s.id
    WHERE s.shop_id = ${shopIdStr}
  `;
  const count = Number(countRows[0]?.count || 0);
  
  if (count >= limit) {
    return { count, isNew: true, allowed: false };
  }
  
  await sql`
    INSERT INTO viewed_vins (shop_id, vin, ro_number, viewed_at)
    SELECT s.id, ${normalizedVin}, ${normalizedRoNumber}, NOW()
    FROM shops s
    WHERE s.shop_id = ${shopIdStr}
    ON CONFLICT DO NOTHING
  `;
  
  return { count: count + 1, isNew: true, allowed: true };
}

export async function trackViewedVin(shopId: number, vin: string, roId?: string | null): Promise<{ count: number; isNew: boolean }> {
  const shopIdStr = String(shopId);
  const normalizedVin = vin.toUpperCase();
  const normalizedRoNumber = roId?.trim() || null;
  
  const existingRows = await sql`
    SELECT vv.id
    FROM viewed_vins vv
    JOIN shops s ON vv.shop_id = s.id
    WHERE s.shop_id = ${shopIdStr}
      AND vv.vin = ${normalizedVin}
      AND (
        (vv.ro_number IS NULL AND ${normalizedRoNumber}::text IS NULL)
        OR vv.ro_number = ${normalizedRoNumber}
      )
    LIMIT 1
  `;
  
  if (existingRows.length > 0) {
    await sql`
      UPDATE viewed_vins
      SET viewed_at = NOW()
      WHERE id = ${existingRows[0].id}
    `;
    
    const countRows = await sql`
      SELECT COUNT(*) as count
      FROM viewed_vins vv
      JOIN shops s ON vv.shop_id = s.id
      WHERE s.shop_id = ${shopIdStr}
    `;
    
    return { count: Number(countRows[0]?.count || 0), isNew: false };
  }
  
  await sql`
    INSERT INTO viewed_vins (shop_id, vin, ro_number, viewed_at)
    SELECT s.id, ${normalizedVin}, ${normalizedRoNumber}, NOW()
    FROM shops s
    WHERE s.shop_id = ${shopIdStr}
    ON CONFLICT DO NOTHING
  `;
  
  const countRows = await sql`
    SELECT COUNT(*) as count
    FROM viewed_vins vv
    JOIN shops s ON vv.shop_id = s.id
    WHERE s.shop_id = ${shopIdStr}
  `;
  
  return { count: Number(countRows[0]?.count || 0), isNew: true };
}

export async function getViewedVinCount(shopId: number): Promise<number> {
  const shopIdStr = String(shopId);
  
  const rows = await sql`
    SELECT COUNT(*) as count
    FROM viewed_vins vv
    JOIN shops s ON vv.shop_id = s.id
    WHERE s.shop_id = ${shopIdStr}
  `;
  
  return Number(rows[0]?.count || 0);
}

export async function hasViewedVin(shopId: number, vin: string): Promise<boolean> {
  const shopIdStr = String(shopId);
  const normalizedVin = vin.toUpperCase();
  
  const rows = await sql`
    SELECT 1
    FROM viewed_vins vv
    JOIN shops s ON vv.shop_id = s.id
    WHERE s.shop_id = ${shopIdStr}
      AND vv.vin = ${normalizedVin}
    LIMIT 1
  `;
  
  return rows.length > 0;
}
