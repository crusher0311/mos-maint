import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { getSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = String(session.shopId);

    const { searchParams } = new URL(request.url);
    const vin = searchParams.get("vin");
    const limit = parseInt(searchParams.get("limit") || "50");

    let vehicles;
    if (vin) {
      vehicles = await sql`
        SELECT * FROM autovitals_vehicles
        WHERE shop_id = ${shopId} AND LOWER(vin) LIKE ${`%${vin.toLowerCase()}%`}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    } else {
      vehicles = await sql`
        SELECT * FROM autovitals_vehicles
        WHERE shop_id = ${shopId}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
    }

    return NextResponse.json({ 
      vehicles: vehicles.map((v: any) => ({
        ...v,
        shopId: v.shop_id,
        updatedAt: v.updated_at
      }))
    });
  } catch (error) {
    console.error("[AutoVitals Vehicles] Error:", error);
    return NextResponse.json({ error: "Failed to fetch vehicles" }, { status: 500 });
  }
}
