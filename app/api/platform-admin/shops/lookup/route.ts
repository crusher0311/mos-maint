import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    
    const body = await request.json();
    const { shopIds } = body as { shopIds: number[] };
    
    if (!Array.isArray(shopIds) || shopIds.length === 0) {
      return NextResponse.json({ shops: {} });
    }
    
    const shopIdStrs = shopIds.map(String);
    const shops = await sql`
      SELECT shop_id, name, location_identifier FROM shops WHERE shop_id = ANY(${shopIdStrs})
    `;
    
    const lookup: Record<number, { name: string; location?: string }> = {};
    for (const shop of shops) {
      lookup[Number((shop as any).shop_id)] = {
        name: (shop as any).name || `Shop ${(shop as any).shop_id}`,
        location: (shop as any).location_identifier || undefined,
      };
    }
    
    return NextResponse.json({ shops: lookup });
  } catch (error: any) {
    console.error("Shop lookup error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
