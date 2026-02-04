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
    const result = await getCommonFailures(
      yearNum,
      make,
      model,
      mileageNum,
      shopIds,
      engine
    );

    return NextResponse.json(result, { headers: corsHeaders });
  } catch (error) {
    console.error("Common failures error:", error);
    return NextResponse.json(
      { error: "Failed to get common failures" },
      { status: 500, headers: corsHeaders }
    );
  }
}
