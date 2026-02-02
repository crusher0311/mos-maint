import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = { shopId: String(session.shopId) };

    const { searchParams } = new URL(request.url);
    const vin = searchParams.get("vin");
    const limit = parseInt(searchParams.get("limit") || "50");

    const db = await getDb();
    const collection = db.collection("autovitals_vehicles");

    let query: Record<string, any> = { shopId: user.shopId };
    
    if (vin) {
      query.vin = { $regex: vin, $options: "i" };
    }

    const vehicles = await collection
      .find(query)
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();

    return NextResponse.json({ vehicles });
  } catch (error) {
    console.error("[AutoVitals Vehicles] Error:", error);
    return NextResponse.json({ error: "Failed to fetch vehicles" }, { status: 500 });
  }
}
