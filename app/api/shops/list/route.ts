import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const scope = searchParams.get("scope");
    
    let shops;
    
    if (session.isPlatformAdmin && scope === "all") {
      shops = await sql`
        SELECT shop_id, name, city, state, enterprise_id 
        FROM shops 
        ORDER BY name ASC
      `;
    } else {
      const sessionShopId = String(session.shopId);
      
      const sessionShopResult = await sql`
        SELECT enterprise_id FROM shops WHERE shop_id = ${sessionShopId} LIMIT 1
      `;
      const enterpriseId = sessionShopResult[0]?.enterprise_id;
      
      if (enterpriseId && session.role === "owner") {
        shops = await sql`
          SELECT shop_id, name, city, state, enterprise_id 
          FROM shops 
          WHERE enterprise_id = ${enterpriseId}
          ORDER BY name ASC
        `;
      } else {
        const userResult = await sql`
          SELECT shop_ids FROM users WHERE email = ${session.email} LIMIT 1
        `;
        const userShopIds = [sessionShopId, ...((userResult[0]?.shop_ids as string[]) || [])];
        
        shops = await sql`
          SELECT shop_id, name, city, state, enterprise_id 
          FROM shops 
          WHERE shop_id = ANY(${userShopIds})
          ORDER BY name ASC
        `;
      }
    }
    
    const formattedShops = shops.map(shop => ({
      shopId: shop.shop_id,
      name: shop.name || `Shop ${shop.shop_id}`,
      location: [shop.city, shop.state].filter(Boolean).join(", ") || null,
    }));
    
    return NextResponse.json({
      ok: true,
      shops: formattedShops,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Error fetching shops:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
