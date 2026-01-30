import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("x-internal-secret");
  if (authHeader !== INTERNAL_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  const shops = await db.collection("shops").find({
    cachedLaborRate: { $exists: false }
  }).toArray();

  let updated = 0;
  for (const shop of shops) {
    const recentJob = await db.collection("job_index").findOne(
      { shopId: shop.shopId, "lines.lineType": "labor", "lines.unitPrice": { $gt: 0 } },
      { sort: { performedAt: -1 } }
    );
    
    if (recentJob?.lines) {
      const laborLine = recentJob.lines.find((l: any) => l.lineType === "labor" && l.unitPrice > 0);
      if (laborLine) {
        await db.collection("shops").updateOne(
          { shopId: shop.shopId },
          { $set: { cachedLaborRate: laborLine.unitPrice, cachedLaborRateUpdatedAt: new Date() } }
        );
        updated++;
        console.log(`[Backfill] Shop ${shop.shopId}: $${laborLine.unitPrice}/hr`);
      }
    }
  }

  return NextResponse.json({ ok: true, shopsChecked: shops.length, updated });
}
