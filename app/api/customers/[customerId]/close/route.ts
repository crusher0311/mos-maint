import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getShopByShopId } from "@/lib/db/shops-pg";
import sql from "@/lib/db/postgres";

export async function POST(_: Request, { params }: { params: { customerId: string } }) {
  const session = await requireSession();
  const now = new Date();

  const shop = await getShopByShopId(session.shopId);
  if (!shop) {
    return NextResponse.json({ ok: false, error: "Shop not found" }, { status: 404 });
  }

  const result = await sql`
    UPDATE customers 
    SET status = 'closed', updated_at = ${now}
    WHERE id = ${params.customerId} AND shop_id = ${shop.id}
    RETURNING id
  `;
  
  // Note: customers table doesn't have a closed_at column in PostgreSQL schema
  // The status = 'closed' and updated_at timestamp serve the same purpose

  if (result.length === 0) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
