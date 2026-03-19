import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const shopIdFilter = req.nextUrl.searchParams.get("shopId");
    const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") || "200", 10), 500);

    const matchStage: any = { "plan.buckets": { $exists: true } };
    if (shopIdFilter) {
      matchStage.shopId = { $in: [String(shopIdFilter), Number(shopIdFilter)] };
    }

    const pipeline = [
      { $match: matchStage },
      { $sort: { createdAt: -1 } },
      { $limit: limit },
      {
        $project: {
          vin: 1,
          shopId: 1,
          "plan.vehicle": 1,
          "plan.buckets.overdue": 1,
          "plan.buckets.dueSoon": 1,
          "plan.buckets.upcoming": 1,
        },
      },
    ];

    const plans = await db.collection("cached_plans").aggregate(pipeline).toArray();

    const keyMap: Record<string, { count: number; samples: Set<string>; buckets: Record<string, number> }> = {};
    const unmapped: { name: string; vin: string; bucket: string }[] = [];

    for (const plan of plans) {
      const buckets = plan.plan?.buckets || {};
      for (const [bucketName, items] of Object.entries(buckets)) {
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          const key = item.key || item.serviceKey || null;
          const title = item.title || item.name || item.service || "unknown";

          if (key) {
            if (!keyMap[key]) {
              keyMap[key] = { count: 0, samples: new Set(), buckets: {} };
            }
            keyMap[key].count++;
            if (keyMap[key].samples.size < 8) {
              keyMap[key].samples.add(title);
            }
            keyMap[key].buckets[bucketName] = (keyMap[key].buckets[bucketName] || 0) + 1;
          } else {
            if (unmapped.length < 200) {
              unmapped.push({ name: title, vin: plan.vin, bucket: bucketName });
            }
          }
        }
      }
    }

    const keys = Object.entries(keyMap)
      .map(([key, data]) => ({
        key,
        count: data.count,
        samples: Array.from(data.samples),
        buckets: data.buckets,
        isComplimentary: key.startsWith("complimentary_") || false,
        isMisc: key.startsWith("misc_") || false,
        isProtractor: key.startsWith("protractor_") || false,
      }))
      .sort((a, b) => b.count - a.count);

    const uniqueUnmapped: Record<string, { name: string; count: number; vins: string[]; bucket: string }> = {};
    for (const u of unmapped) {
      const lowerName = u.name.toLowerCase();
      if (!uniqueUnmapped[lowerName]) {
        uniqueUnmapped[lowerName] = { name: u.name, count: 0, vins: [], bucket: u.bucket };
      }
      uniqueUnmapped[lowerName].count++;
      if (uniqueUnmapped[lowerName].vins.length < 3) {
        uniqueUnmapped[lowerName].vins.push(u.vin);
      }
    }

    return NextResponse.json({
      totalPlansScanned: plans.length,
      totalKeys: keys.length,
      keys,
      unmapped: Object.values(uniqueUnmapped).sort((a, b) => b.count - a.count),
    });
  } catch (err: any) {
    console.error("[Service Keys API]", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
