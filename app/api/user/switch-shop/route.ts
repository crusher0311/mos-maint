import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import { getSession, sessionCookieOptions } from "@/lib/auth";
import { sql } from "@/lib/db/postgres";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { shopId } = await req.json();
    if (typeof shopId !== "number") {
      return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
    }

    // Find the user in the target shop
    const userInShopRows = await sql`
      SELECT u.id, u.email, s.id as shop_uuid, s.name as shop_name
      FROM users u
      JOIN shops s ON u.shop_id = s.id
      WHERE LOWER(u.email) = ${session.email.toLowerCase()}
        AND s.shop_id = ${String(shopId)}
      LIMIT 1
    `;

    if (userInShopRows.length === 0) {
      return NextResponse.json(
        { error: "You don't have access to this shop" },
        { status: 403 }
      );
    }

    const userInShop = userInShopRows[0];
    const newToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

    // Create new session
    await sql`
      INSERT INTO sessions (token, user_id, shop_id, created_at, expires_at)
      VALUES (${newToken}, ${userInShop.id}, ${userInShop.shop_uuid}, NOW(), ${expiresAt})
    `;

    const store = await cookies();
    store.set("session_token", newToken, sessionCookieOptions(60 * 60 * 24 * 30));

    const shopName = userInShop.shop_name || `Shop ${shopId}`;

    return NextResponse.json({
      ok: true,
      shopId,
      shopName,
    });
  } catch (err) {
    console.error("Error switching shop:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
