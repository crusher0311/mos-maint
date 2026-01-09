import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = await getDb();
    
    const shops = await db.collection("shops")
      .find({})
      .project({ shopId: 1, name: 1, city: 1, state: 1 })
      .sort({ name: 1 })
      .toArray();
    
    const formattedShops = shops.map(shop => ({
      shopId: shop.shopId,
      name: shop.name || `Shop ${shop.shopId}`,
      location: [shop.city, shop.state].filter(Boolean).join(", ") || null,
    }));
    
    return NextResponse.json({
      ok: true,
      shops: formattedShops,
    });
  } catch (err: any) {
    console.error("Error fetching shops:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
