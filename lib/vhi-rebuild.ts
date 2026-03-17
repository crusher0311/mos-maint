import { getDb } from "@/lib/mongo";
import { getCachedPlan, invalidateCachedPlan, type CachedPlan } from "@/lib/plan-cache";
import { computeScore, getScoreTier, formatVhiItem } from "@/lib/vhi-score";

export interface VhiRebuildResult {
  success: boolean;
  vin: string;
  shopId: number;
  built: boolean;
  score?: {
    value: number;
    tier: string;
    color: string;
  };
  vehicle?: {
    year: number | null;
    make: string | null;
    model: string | null;
    engine: string | null;
  };
  currentMiles?: number | null;
  distanceUnit?: string;
  customerName?: string | null;
  summary?: {
    overdue: number;
    dueSoon: number;
    upcoming: number;
  };
  buckets?: {
    overdue: any[];
    dueSoon: any[];
    upcoming: any[];
  };
  cachedAt?: Date;
  error?: string;
}

function getInternalSecret(): string {
  return Buffer.from(process.env.DATABASE_URL || "").toString("base64").slice(0, 32);
}

export async function triggerPlanBuild(
  shopId: number,
  vin: string,
  mileage: number
): Promise<boolean> {
  try {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : `http://localhost:${process.env.PORT || 5000}`;

    const res = await fetch(
      `${baseUrl}/api/plan-build?vin=${encodeURIComponent(vin)}&mileage=${mileage}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-secret": getInternalSecret(),
          "x-internal-shop-id": String(shopId),
        },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      console.error(`[VHI Rebuild] Plan build failed (${res.status}):`, text.slice(0, 300));
      return false;
    }

    return true;
  } catch (err: any) {
    console.error(`[VHI Rebuild] Plan build trigger error:`, err.message);
    return false;
  }
}

export async function rebuildVhi(
  shopId: number,
  vin: string,
  mileage: number,
  options: { invalidateFirst?: boolean } = {}
): Promise<VhiRebuildResult> {
  const db = await getDb();
  const vinUpper = vin.toUpperCase();

  if (options.invalidateFirst) {
    await invalidateCachedPlan(db, vinUpper, shopId);
  }

  let cached = await getCachedPlan(db, vinUpper, shopId, mileage);

  if (!cached) {
    console.log(`[VHI Rebuild] No cached plan for ${vinUpper} at shop ${shopId}, triggering build...`);
    const built = await triggerPlanBuild(shopId, vinUpper, mileage);

    if (!built) {
      return {
        success: false,
        vin: vinUpper,
        shopId,
        built: false,
        error: "Failed to build maintenance plan",
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    cached = await getCachedPlan(db, vinUpper, shopId, mileage);

    if (!cached) {
      return {
        success: false,
        vin: vinUpper,
        shopId,
        built: true,
        error: "Plan build completed but cache not yet available",
      };
    }
  }

  const plan = cached.plan;
  const score = computeScore(plan.buckets);
  const tier = getScoreTier(score);

  return {
    success: true,
    vin: vinUpper,
    shopId,
    built: !options.invalidateFirst ? false : true,
    score: {
      value: score,
      tier: tier.label,
      color: tier.color,
    },
    vehicle: {
      year: plan.vehicle.year ?? null,
      make: plan.vehicle.make ?? null,
      model: plan.vehicle.model ?? null,
      engine: plan.vehicle.engine ?? null,
    },
    currentMiles: plan.currentMiles,
    distanceUnit: plan.distanceUnit,
    customerName: plan.customerName ?? null,
    summary: {
      overdue: plan.buckets.overdue.length,
      dueSoon: plan.buckets.dueSoon.length,
      upcoming: plan.buckets.upcoming.length,
    },
    buckets: {
      overdue: plan.buckets.overdue.map(formatVhiItem),
      dueSoon: plan.buckets.dueSoon.map(formatVhiItem),
      upcoming: plan.buckets.upcoming.map(formatVhiItem),
    },
    cachedAt: cached.createdAt,
  };
}

export async function resolveMileageFromRo(
  db: any,
  shopId: number,
  provider: string,
  vin: string,
  roNumber?: string | null
): Promise<number | null> {
  const vinUpper = vin.toUpperCase();

  if (provider === "tekmetric") {
    const query: any = {
      shopId: { $in: [String(shopId), Number(shopId)] },
      vin: vinUpper,
    };
    if (roNumber) {
      query.$or = [
        { workOrderNumber: roNumber },
        { workOrderNumber: Number(roNumber) },
        { workOrderId: roNumber },
      ];
    }
    const wo = await db
      .collection("tekmetric_work_orders")
      .findOne(query, { sort: { createdAt: -1 }, projection: { odometer: 1 } });
    return wo?.odometer ?? null;
  }

  if (provider === "shopware") {
    const query: any = {
      mosShopId: { $in: [String(shopId), Number(shopId)] },
      vin: vinUpper,
    };
    if (roNumber) {
      query.$or = [
        { number: roNumber },
        { number: Number(roNumber) },
        { roId: Number(roNumber) },
      ];
    }
    const ro = await db
      .collection("shopware_repair_orders")
      .findOne(query, { sort: { updatedAt: -1 }, projection: { odometer: 1, "raw.odometer": 1, "raw.odometer_out": 1 } });
    return ro?.raw?.odometer_out ?? ro?.raw?.odometer ?? ro?.odometer ?? null;
  }

  if (provider === "protractor") {
    const query: any = {
      shopId: { $in: [String(shopId), Number(shopId)] },
      vin: vinUpper,
    };
    if (roNumber) {
      query.workOrderNumber = roNumber;
    }
    const wo = await db
      .collection("protractor_work_orders")
      .findOne(query, {
        sort: { updatedAt: -1 },
        projection: { OutUsage: 1, InUsage: 1, Odometer: 1, "data.OutUsage": 1, "data.InUsage": 1, "data.Odometer": 1 },
      });
    return wo?.OutUsage ?? wo?.InUsage ?? wo?.Odometer ??
      wo?.data?.OutUsage ?? wo?.data?.InUsage ?? wo?.data?.Odometer ?? null;
  }

  const vehicleDoc = await db.collection("vehicles").findOne(
    { shopId, vin: vinUpper },
    { projection: { currentMileage: 1, lastMileage: 1 } }
  );
  return vehicleDoc?.currentMileage ?? vehicleDoc?.lastMileage ?? null;
}
