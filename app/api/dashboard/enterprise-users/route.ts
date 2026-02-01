import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopRows = await sql`
      SELECT id, shop_id, enterprise_id, name, location_identifier 
      FROM shops WHERE shop_id = ${String(session.shopId)} LIMIT 1
    `;
    const shop = shopRows[0];
    
    if (!shop?.enterprise_id) {
      return NextResponse.json({ error: "Shop not part of an enterprise" }, { status: 404 });
    }

    const enterpriseRows = await sql`
      SELECT id, name, shop_ids FROM enterprise_accounts WHERE id = ${shop.enterprise_id} LIMIT 1
    `;
    const enterprise = enterpriseRows[0];

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    const shopIds = enterprise.shop_ids || [];

    const shops = await sql`
      SELECT shop_id, name, location_identifier 
      FROM shops WHERE shop_id = ANY(${shopIds.map(String)})
    `;

    const shopMap = new Map(shops.map((s: any) => [s.shop_id, s.name || `Shop ${s.shop_id}`]));

    const users = await sql`
      SELECT id, email, role, shop_id, name, created_at 
      FROM users WHERE shop_id = ANY(${shopIds.map(String)})
    `;

    const usersByEmail: Record<string, any> = {};
    for (const u of users) {
      const email = u.email.toLowerCase();
      if (!usersByEmail[email]) {
        usersByEmail[email] = {
          email,
          name: u.name || null,
          role: u.role,
          createdAt: u.created_at,
          shopAccess: [],
        };
      }
      usersByEmail[email].shopAccess.push({
        shopId: u.shop_id,
        shopName: shopMap.get(u.shop_id) || `Shop ${u.shop_id}`,
        userId: u.id.toString(),
      });
    }

    const userList = Object.values(usersByEmail).sort((a: any, b: any) =>
      a.email.localeCompare(b.email)
    );

    return NextResponse.json({
      enterprise: {
        id: enterprise.id.toString(),
        name: enterprise.name,
      },
      shops: shops.map((s: any) => ({
        shopId: s.shop_id,
        name: s.name || `Shop ${s.shop_id}`,
        locationIdentifier: s.location_identifier || null,
      })),
      users: userList,
    });
  } catch (err) {
    console.error("Error fetching enterprise users:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!["owner", "admin"].includes(session.role)) {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }

    const { email, shopId, action } = await req.json();

    if (!email || !shopId || !action) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const shopRows = await sql`
      SELECT id, shop_id, enterprise_id, name 
      FROM shops WHERE shop_id = ${String(session.shopId)} LIMIT 1
    `;
    const shop = shopRows[0];
    
    if (!shop?.enterprise_id) {
      return NextResponse.json({ error: "Shop not part of an enterprise" }, { status: 403 });
    }

    const enterpriseRows = await sql`
      SELECT id, name, shop_ids FROM enterprise_accounts WHERE id = ${shop.enterprise_id} LIMIT 1
    `;
    const enterprise = enterpriseRows[0];

    if (!enterprise || !enterprise.shop_ids?.includes(shopId)) {
      return NextResponse.json({ error: "Shop not in your enterprise" }, { status: 400 });
    }

    const targetShopRows = await sql`
      SELECT name FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;
    const shopName = targetShopRows[0]?.name || `Shop ${shopId}`;

    if (action === "grant") {
      const existingUserRows = await sql`
        SELECT id FROM users WHERE LOWER(email) = ${email.toLowerCase()} AND shop_id = ${String(shopId)} LIMIT 1
      `;

      if (existingUserRows[0]) {
        return NextResponse.json({ error: "User already has access to this shop" }, { status: 400 });
      }

      const sourceUserRows = await sql`
        SELECT email, name, role, password_hash 
        FROM users 
        WHERE LOWER(email) = ${email.toLowerCase()} AND shop_id = ANY(${enterprise.shop_ids.map(String)})
        LIMIT 1
      `;
      const sourceUser = sourceUserRows[0];

      if (!sourceUser) {
        return NextResponse.json({ error: "User not found in enterprise" }, { status: 404 });
      }

      await sql`
        INSERT INTO users (email, name, role, shop_id, password_hash, created_at, granted_by)
        VALUES (${email.toLowerCase()}, ${sourceUser.name}, ${sourceUser.role}, ${String(shopId)}, ${sourceUser.password_hash}, NOW(), ${session.email})
      `;

      return NextResponse.json({
        ok: true,
        message: `Access granted to ${shopName}`,
      });
    } else if (action === "revoke") {
      const userAccountsRows = await sql`
        SELECT id FROM users 
        WHERE LOWER(email) = ${email.toLowerCase()} AND shop_id = ANY(${enterprise.shop_ids.map(String)})
      `;

      if (userAccountsRows.length <= 1) {
        return NextResponse.json({
          error: "Cannot revoke - user must have at least one shop access",
        }, { status: 400 });
      }

      await sql`
        DELETE FROM users WHERE LOWER(email) = ${email.toLowerCase()} AND shop_id = ${String(shopId)}
      `;

      await sql`
        DELETE FROM sessions WHERE shop_id = ${String(shopId)}
      `;

      return NextResponse.json({
        ok: true,
        message: `Access revoked from ${shopName}`,
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("Error managing enterprise user:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
