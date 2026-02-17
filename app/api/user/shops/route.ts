import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    
    const userRecords = await db
      .collection("users")
      .find({ email: session.email.toLowerCase() })
      .project({ shopId: 1, shopIds: 1 })
      .toArray();

    const allShopIds = new Set<number>();
    for (const u of userRecords) {
      if (u.shopId) allShopIds.add(Number(u.shopId));
      if (Array.isArray(u.shopIds)) {
        for (const sid of u.shopIds) {
          allShopIds.add(Number(sid));
        }
      }
    }
    const shopIds = [...allShopIds];

    const shops = await db
      .collection("shops")
      .find({ shopId: { $in: shopIds } })
      .project({ shopId: 1, name: 1, locationIdentifier: 1 })
      .toArray();

    const shopList = shops.map((s) => ({
      shopId: Number(s.shopId),
      name: s.name || `Shop ${s.shopId}`,
      locationIdentifier: s.locationIdentifier || null,
      displayName: s.locationIdentifier || s.name || `Shop ${s.shopId}`,
    }));

    shopList.sort((a, b) => a.displayName.localeCompare(b.displayName));

    return NextResponse.json({
      currentShopId: session.shopId,
      shops: shopList,
    });
  } catch (err) {
    console.error("Error fetching user shops:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
