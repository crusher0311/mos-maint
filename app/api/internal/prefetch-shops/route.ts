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

  try {
    const db = await getDb();
    
    // Match shops that have any integration configured
    // Protractor: uses protractor.configured or protractor.apiKey
    // Tekmetric: uses tekmetric.configured or tekmetric.shopId
    const shops = await db.collection("shops").find({
      $or: [
        { "protractor.configured": true },
        { "protractor.apiKey": { $exists: true, $ne: null } },
        { "tekmetric.configured": true },
        { "tekmetric.shopId": { $exists: true, $ne: null } }
      ]
    }).project({
      shopId: 1,
      name: 1,
      "protractor.configured": 1,
      "protractor.apiKey": 1,
      "tekmetric.configured": 1,
      "tekmetric.shopId": 1
    }).toArray();

    return NextResponse.json({ shops });
  } catch (error: any) {
    console.error("[InternalAPI] Error fetching shops:", error.message);
    return NextResponse.json({ error: "Failed to fetch shops" }, { status: 500 });
  }
}
