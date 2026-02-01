import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { getCommonFailures } from "@/lib/common-failures";
import { getNormalizedCache, CACHE_KEYS, CACHE_TTL } from "@/lib/normalized-cache";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
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
      { status: 400 }
    );
  }

  const yearNum = parseInt(year);
  const mileageNum = parseInt(mileage);

  if (isNaN(yearNum) || yearNum < 1900 || yearNum > new Date().getFullYear() + 2) {
    return NextResponse.json({ error: "Invalid year" }, { status: 400 });
  }

  if (isNaN(mileageNum) || mileageNum < 0 || mileageNum > 1000000) {
    return NextResponse.json({ error: "Invalid mileage" }, { status: 400 });
  }

  const cache = getNormalizedCache();
  
  let shopIds: number[] = [shopId];
  if (includeEnterprise) {
    const enterpriseCacheKey = { shopId };
    let cachedEnterpriseShops = cache.get<number[]>(CACHE_KEYS.ENTERPRISE_SHOPS, enterpriseCacheKey);
    
    if (!cachedEnterpriseShops) {
      const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${String(shopId)}`;
      const shop = shopRows[0] as any;
      const enterpriseId = shop?.enterprise_id as string | undefined;
      
      if (enterpriseId) {
        const enterpriseShops = await sql`SELECT * FROM shops WHERE enterprise_id = ${enterpriseId}`;
        cachedEnterpriseShops = enterpriseShops.map((s: any) => Number(s.shop_id));
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

    return NextResponse.json(result);
  } catch (error) {
    console.error("Common failures error:", error);
    return NextResponse.json(
      { error: "Failed to get common failures" },
      { status: 500 }
    );
  }
}
