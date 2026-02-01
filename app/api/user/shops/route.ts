import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sql } from "@/lib/db/postgres";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get all shops this user has access to
    const userShops = await sql`
      SELECT DISTINCT u.shop_id, s.shop_id as numeric_shop_id, s.name, s.location_identifier
      FROM users u
      JOIN shops s ON u.shop_id = s.id::text
      WHERE LOWER(u.email) = ${session.email.toLowerCase()}
    `;

    const shopList = userShops.map((s) => ({
      shopId: Number(s.numeric_shop_id),
      name: s.name || `Shop ${s.numeric_shop_id}`,
      locationIdentifier: s.location_identifier || null,
      displayName: s.location_identifier || s.name || `Shop ${s.numeric_shop_id}`,
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
