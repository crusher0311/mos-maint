import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEnterpriseById } from "@/lib/enterprise-pg";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const enterpriseId = searchParams.get("enterpriseId");

    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID required" }, { status: 400 });
    }

    const enterprise = await getEnterpriseById(enterpriseId);

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    const shopIds = enterprise.shop_ids || [];

    const shops = shopIds.length > 0 ? await sql<{shop_id: string, name: string | null, location_identifier: string | null}[]>`
      SELECT shop_id, name, location_identifier FROM shops
      WHERE shop_id::int = ANY(${shopIds})
    ` : [];

    const shopMap = new Map(shops.map((s) => [s.shop_id, { 
      name: s.name || `Shop ${s.shop_id}`, 
      locationIdentifier: s.location_identifier || null 
    }]));

    const users = shopIds.length > 0 ? await sql<{id: string, email: string, role: string | null, shop_id: string, name: string | null, created_at: Date}[]>`
      SELECT id, email, role, shop_id, name, created_at FROM users
      WHERE shop_id::int = ANY(${shopIds})
    ` : [];

    const usersByEmail: Record<string, {
      email: string;
      name: string | null;
      role: string | null;
      createdAt: Date;
      shopAccess: Array<{shopId: number; shopName: string; locationIdentifier: string | null; userId: string}>;
    }> = {};
    
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
      const shopInfo = shopMap.get(u.shop_id);
      usersByEmail[email].shopAccess.push({
        shopId: parseInt(u.shop_id, 10),
        shopName: shopInfo?.name || `Shop ${u.shop_id}`,
        locationIdentifier: shopInfo?.locationIdentifier || null,
        userId: u.id,
      });
    }

    const userList = Object.values(usersByEmail).sort((a, b) =>
      a.email.localeCompare(b.email)
    );

    return NextResponse.json({
      enterprise: {
        id: enterprise.id,
        name: enterprise.name,
      },
      shops: shops.map((s) => ({
        shopId: parseInt(s.shop_id, 10),
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

    const { enterpriseId, email, shopId, action } = await req.json();

    if (!enterpriseId || !email || !shopId || !action) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const enterprise = await getEnterpriseById(enterpriseId);

    if (!enterprise || !enterprise.shop_ids?.includes(Number(shopId))) {
      return NextResponse.json({ error: "Shop not in enterprise" }, { status: 400 });
    }

    const shopResult = await sql<{name: string | null}[]>`
      SELECT name FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;
    const shopName = shopResult[0]?.name || `Shop ${shopId}`;

    if (action === "grant") {
      const existingUser = await sql`
        SELECT id FROM users WHERE LOWER(email) = LOWER(${email}) AND shop_id = ${String(shopId)} LIMIT 1
      `;

      if (existingUser.length > 0) {
        return NextResponse.json({ error: "User already has access to this shop" }, { status: 400 });
      }

      const sourceUsers = await sql<{email: string, name: string | null, password_hash: string, role: string | null}[]>`
        SELECT email, name, password_hash, role FROM users
        WHERE LOWER(email) = LOWER(${email}) AND shop_id::int = ANY(${enterprise.shop_ids})
        LIMIT 1
      `;

      if (sourceUsers.length === 0) {
        return NextResponse.json({ error: "User not found in enterprise" }, { status: 404 });
      }

      const sourceUser = sourceUsers[0];

      await sql`
        INSERT INTO users (id, email, name, role, shop_id, password_hash, created_at, updated_at)
        VALUES (gen_random_uuid(), LOWER(${email}), ${sourceUser.name}, ${sourceUser.role}, ${String(shopId)}, ${sourceUser.password_hash}, NOW(), NOW())
      `;

      return NextResponse.json({
        ok: true,
        message: `Access granted to ${shopName}`,
      });
    } else if (action === "revoke") {
      const userAccounts = await sql`
        SELECT id FROM users WHERE LOWER(email) = LOWER(${email}) AND shop_id::int = ANY(${enterprise.shop_ids})
      `;

      if (userAccounts.length <= 1) {
        return NextResponse.json({
          error: "Cannot revoke - user must have at least one shop access",
        }, { status: 400 });
      }

      await sql`
        DELETE FROM users WHERE LOWER(email) = LOWER(${email}) AND shop_id = ${String(shopId)}
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
