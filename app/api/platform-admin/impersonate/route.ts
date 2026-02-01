import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import crypto from "crypto";
import { getSession, sessionCookieOptions, adminSessionCookieOptions } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { logAdminAction } from "@/lib/audit-log";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session || !session.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { shopId: rawShopId } = await req.json();

    const shopId = typeof rawShopId === "string" && !isNaN(Number(rawShopId)) 
      ? String(rawShopId) 
      : String(rawShopId);

    if (shopId === undefined || shopId === null || shopId === "undefined" || shopId === "null") {
      return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
    }

    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${shopId}`;
    const shop = shopRows[0] as any;
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    if (shop.is_locked) {
      return NextResponse.json({ error: "Shop is locked. Unlock it first to access." }, { status: 403 });
    }

    let userRows = await sql`SELECT * FROM users WHERE shop_id = ${shopId} AND role = 'owner' LIMIT 1`;
    let targetUser = userRows[0] as any;

    if (!targetUser) {
      userRows = await sql`SELECT * FROM users WHERE shop_id = ${shopId} LIMIT 1`;
      targetUser = userRows[0] as any;
    }

    if (!targetUser) {
      return NextResponse.json({ error: "No users found for this shop" }, { status: 404 });
    }

    const newToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 4);

    await sql`
      INSERT INTO sessions (token, user_id, shop_id, created_at, expires_at, impersonated_by, is_impersonation)
      VALUES (${newToken}, ${targetUser.id}, ${shopId}, NOW(), ${expiresAt}, ${session.email}, true)
    `;

    const headerStore = await headers();
    await logAdminAction({
      action: "impersonation",
      adminEmail: session.email,
      targetShopId: Number(shopId),
      targetShopName: shop.name,
      targetUserEmail: targetUser.email,
      ipAddress: headerStore.get("x-forwarded-for") || headerStore.get("x-real-ip") || undefined,
      userAgent: headerStore.get("user-agent") || undefined,
      details: { sessionExpiry: expiresAt }
    });

    const store = await cookies();
    const currentAdminToken = store.get("session_token")?.value;
    
    if (currentAdminToken) {
      store.set("admin_session_token", currentAdminToken, adminSessionCookieOptions(60 * 60 * 8));
    }
    
    store.set("session_token", newToken, sessionCookieOptions(60 * 60 * 4));

    return NextResponse.json({
      ok: true,
      shopId: Number(shopId),
      shopName: shop.name || `Shop ${shopId}`,
      userEmail: targetUser.email,
    });
  } catch (err) {
    console.error("Error impersonating shop:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
