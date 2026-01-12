import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = await getDb();
    const { searchParams } = new URL(req.url);
    const scope = searchParams.get("scope");
    
    let query: any = {};
    
    if (session.isPlatformAdmin && scope === "all") {
      query = {};
    } else {
      const sessionShopId = String(session.shopId);
      const sessionShop = await db.collection("shops").findOne({
        shopId: { $in: [sessionShopId, Number(sessionShopId)] }
      });
      
      const enterpriseId = sessionShop?.enterpriseId;
      
      if (enterpriseId && session.role === "owner") {
        query = { enterpriseId };
      } else {
        const user = await db.collection("users").findOne({ email: session.email });
        const userShopIds = [session.shopId, ...(user?.shopIds || [])].map(id => 
          isNaN(Number(id)) ? id : Number(id)
        );
        query = { shopId: { $in: userShopIds } };
      }
    }
    
    const shops = await db.collection("shops")
      .find(query)
      .project({ shopId: 1, name: 1, city: 1, state: 1, enterpriseId: 1, locationIdentifier: 1 })
      .sort({ name: 1 })
      .toArray();
    
    const formattedShops = shops.map(shop => ({
      shopId: shop.shopId,
      name: shop.name || `Shop ${shop.shopId}`,
      location: [shop.city, shop.state].filter(Boolean).join(", ") || null,
      locationIdentifier: shop.locationIdentifier || null,
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
