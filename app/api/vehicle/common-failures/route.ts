import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getCommonFailures } from "@/lib/common-failures";
import { getNormalizedCache, CACHE_KEYS, CACHE_TTL } from "@/lib/normalized-cache";
import { validateExtensionToken } from "@/lib/extension-auth";

export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  // Try session auth first, then token auth for extension
  let shopId: number | null = null;
  
  const session = await getSession();
  if (session) {
    shopId = Number(session.shopId);
  } else {
    // Try extension token auth
    const auth = await validateExtensionToken(req);
    if (auth.authorized && auth.user) {
      shopId = Number(auth.user.shopId);
    }
  }
  
  if (!shopId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
  }

  const url = new URL(req.url);
  
  const year = url.searchParams.get("year");
  const make = url.searchParams.get("make");
  const model = url.searchParams.get("model");
  const mileage = url.searchParams.get("mileage");
  const engine = url.searchParams.get("engine") || undefined;
  const includeEnterprise = url.searchParams.get("enterprise") === "true";
  // Caller-provided unit hint. Falls back to the shop's stored preference.
  // The mileage in the query string is ALREADY in this unit (the dashboard
  // panel reads `vehicle.mileage` straight from the vehicles collection,
  // which is stored in shop units), so we don't double-convert it.
  let unit: "miles" | "kilometers" =
    url.searchParams.get("unit") === "kilometers" ? "kilometers" : "miles";
  if (!url.searchParams.get("unit")) {
    try {
      // Match both string and number shopId variants (legacy docs use either)
      // so the fallback doesn't silently render "mi" for numeric-only docs.
      const shopDoc = await (await getDb()).collection("shops").findOne(
        { shopId: { $in: [String(shopId), Number(shopId)] } as any },
        { projection: { "preferences.distanceUnit": 1 } }
      );
      if (shopDoc?.preferences?.distanceUnit === "kilometers") unit = "kilometers";
    } catch {
      // best-effort — falls back to "miles" on lookup failure
    }
  }
  const isMetric = unit === "kilometers";

  if (!year || !make || !model || !mileage) {
    return NextResponse.json(
      { error: "Missing required parameters: year, make, model, mileage" },
      { status: 400, headers: corsHeaders }
    );
  }

  const yearNum = parseInt(year);
  const mileageNum = parseInt(mileage);

  if (isNaN(yearNum) || yearNum < 1900 || yearNum > new Date().getFullYear() + 2) {
    return NextResponse.json({ error: "Invalid year" }, { status: 400, headers: corsHeaders });
  }

  if (isNaN(mileageNum) || mileageNum < 0 || mileageNum > 1000000) {
    return NextResponse.json({ error: "Invalid mileage" }, { status: 400, headers: corsHeaders });
  }

  const db = await getDb();
  const cache = getNormalizedCache();
  
  let shopIds: number[] = [shopId];
  if (includeEnterprise) {
    const enterpriseCacheKey = { shopId };
    let cachedEnterpriseShops = cache.get<number[]>(CACHE_KEYS.ENTERPRISE_SHOPS, enterpriseCacheKey);
    
    if (!cachedEnterpriseShops) {
      const shop = await db.collection("shops").findOne({ shopId: String(shopId) });
      const enterpriseId = shop?.enterpriseId as string | undefined;
      
      if (enterpriseId) {
        const enterpriseShops = await db.collection("shops")
          .find({ enterpriseId })
          .toArray();
        cachedEnterpriseShops = enterpriseShops.map(s => Number(s.shopId));
        cache.set(CACHE_KEYS.ENTERPRISE_SHOPS, enterpriseCacheKey, cachedEnterpriseShops, CACHE_TTL.LONG);
      } else {
        cachedEnterpriseShops = [shopId];
      }
    }
    shopIds = cachedEnterpriseShops;
  }

  try {
    // Convert the inbound mileage to miles when the shop is on km — the
    // lib's bucket math (`Math.floor(mileage / 5000) * 5000`) and AI prompt
    // both think in miles, so feeding it 200,000 km when the car is really
    // ~124k mi would put it in the wrong service-life bucket. Pass the
    // un-rounded float so `Math.floor` inside the lib does all the bucket
    // selection — pre-rounding here can shift values across a 5,000-mi
    // boundary (e.g., 4,999.6 → 5,000 lands in the next bucket).
    const MILES_PER_KM = 0.621371;
    const mileageForLib = isMetric ? mileageNum * MILES_PER_KM : mileageNum;

    const result = await getCommonFailures(
      yearNum,
      make,
      model,
      mileageForLib,
      shopIds,
      engine
    );

    // Project the response back into shop units so the panel renders
    // consistent labels. `result.vehicle.mileage` echoes the input bucket,
    // and `failure.typicalMileageRange` is a "X - Y miles" string built in
    // miles — both need conversion when the shop is on km.
    if (isMetric && result) {
      const KM_PER_MILE = 1.609344;
      if (result.vehicle && typeof result.vehicle.mileage === "number") {
        result.vehicle.mileage = Math.round(result.vehicle.mileage * KM_PER_MILE);
      }
      if (typeof result.mileageBucket === "number") {
        result.mileageBucket = Math.round(result.mileageBucket * KM_PER_MILE);
      }
      if (Array.isArray(result.failures)) {
        const rangeRegex = /([\d,]+)\s*[-–]\s*([\d,]+)\s*miles?/i;
        const singleRegex = /([\d,]+)\s*miles?/gi;
        for (const f of result.failures) {
          if (typeof f.typicalMileageRange !== "string") continue;
          const m = f.typicalMileageRange.match(rangeRegex);
          if (m) {
            const lo = Math.round(parseInt(m[1].replace(/,/g, ""), 10) * KM_PER_MILE);
            const hi = Math.round(parseInt(m[2].replace(/,/g, ""), 10) * KM_PER_MILE);
            f.typicalMileageRange = `${lo.toLocaleString()} - ${hi.toLocaleString()} km`;
          } else {
            f.typicalMileageRange = f.typicalMileageRange.replace(singleRegex, (_, n) => {
              const v = Math.round(parseInt(String(n).replace(/,/g, ""), 10) * KM_PER_MILE);
              return `${v.toLocaleString()} km`;
            });
          }
        }
      }
    }

    return NextResponse.json({ ...result, distanceUnit: unit }, { headers: corsHeaders });
  } catch (error) {
    console.error("Common failures error:", error);
    return NextResponse.json(
      { error: "Failed to get common failures" },
      { status: 500, headers: corsHeaders }
    );
  }
}
