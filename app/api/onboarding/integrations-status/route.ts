import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";

export async function GET() {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();

    const sessRows = await sql`
      SELECT * FROM sessions WHERE token = ${sid} AND expires_at > ${now} LIMIT 1
    `;
    const sess = sessRows[0];
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const userRows = await sql`SELECT * FROM users WHERE id = ${sess.user_id} LIMIT 1`;
    const user = userRows[0];
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const shopRows = await sql`
      SELECT settings FROM shops WHERE shop_id = ${String(user.shop_id)} LIMIT 1
    `;
    const shop = shopRows[0];
    const settings = shop?.settings || {};

    const hasProtractor = !!(settings.protractor?.baseUrl && settings.protractor?.apiKey);
    const hasTekmetric = !!settings.tekmetric?.shopId;
    const hasAutoFlow = !!settings.autoflow?.apiKey;
    const hasCarfax = !!settings.carfax?.locationId;

    return NextResponse.json({
      hasIntegration: hasProtractor || hasTekmetric || hasAutoFlow || hasCarfax,
      integrations: {
        protractor: hasProtractor,
        tekmetric: hasTekmetric,
        autoflow: hasAutoFlow,
        carfax: hasCarfax,
      }
    });
  } catch (error) {
    console.error("Error checking integration status:", error);
    return NextResponse.json({ error: "Failed to check status" }, { status: 500 });
  }
}
