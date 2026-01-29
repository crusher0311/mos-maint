import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";

export async function GET(req: Request) {
  const authHeader = req.headers.get("x-internal-secret");
  if (authHeader !== INTERNAL_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const shopId = parseInt(url.searchParams.get("shopId") || "0", 10);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);

  if (!shopId) {
    return NextResponse.json({ error: "shopId required" }, { status: 400 });
  }

  try {
    const db = await getDb();
    
    const vehicles = await db.collection("vehicles")
      .find({ 
        shopId,
        vin: { $exists: true, $ne: null },
        mileage: { $exists: true, $gt: 0 }
      })
      .sort({ lastSeenAt: -1, updatedAt: -1 })
      .limit(limit)
      .project({
        vin: 1,
        mileage: 1,
        year: 1,
        make: 1,
        model: 1
      })
      .toArray();

    return NextResponse.json({ 
      rows: vehicles.map(v => ({
        vin: v.vin,
        mileage: v.mileage,
        year: v.year,
        make: v.make,
        model: v.model
      }))
    });
  } catch (error: any) {
    console.error("[InternalAPI] Error fetching vehicles:", error.message);
    return NextResponse.json({ error: "Failed to fetch vehicles" }, { status: 500 });
  }
}
