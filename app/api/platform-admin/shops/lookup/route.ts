import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    
    const body = await request.json();
    const { shopIds } = body as { shopIds: number[] };
    
    if (!Array.isArray(shopIds) || shopIds.length === 0) {
      return NextResponse.json({ shops: {} });
    }
    
    const db = await getDb();
    const shops = await db.collection("shops").find(
      { shopId: { $in: shopIds } },
      { projection: { shopId: 1, name: 1 } }
    ).toArray();
    
    const lookup: Record<number, string> = {};
    for (const shop of shops) {
      lookup[shop.shopId] = shop.name || `Shop ${shop.shopId}`;
    }
    
    return NextResponse.json({ shops: lookup });
  } catch (error: any) {
    console.error("Shop lookup error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
