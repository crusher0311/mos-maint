import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const adminToken = cookieStore.get("admin_session_token")?.value;
    const currentToken = cookieStore.get("session_token")?.value;

    if (!adminToken || !currentToken) {
      return NextResponse.json({ isGhostMode: false });
    }

    const sessionRows = await sql`
      SELECT * FROM sessions 
      WHERE token = ${currentToken} AND is_impersonation = true
      LIMIT 1
    `;
    const currentSession = sessionRows[0];

    if (!currentSession) {
      return NextResponse.json({ isGhostMode: false });
    }

    const shopRows = await sql`
      SELECT name FROM shops WHERE shop_id = ${currentSession.shop_id} LIMIT 1
    `;
    const shop = shopRows[0];

    const userRows = await sql`
      SELECT email FROM users WHERE id = ${currentSession.user_id} LIMIT 1
    `;
    const user = userRows[0];

    return NextResponse.json({
      isGhostMode: true,
      adminEmail: currentSession.impersonated_by,
      shopName: shop?.name || `Shop ${currentSession.shop_id}`,
      shopId: currentSession.shop_id,
      impersonatingAs: user?.email || "Unknown User",
    });
  } catch (error) {
    console.error("Error checking ghost mode:", error);
    return NextResponse.json({ isGhostMode: false });
  }
}
