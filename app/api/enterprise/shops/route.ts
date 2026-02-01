import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  getEnterpriseById, 
  addShopToEnterprise, 
  removeShopFromEnterprise 
} from "@/lib/enterprise-pg";
import { upsertShop } from "@/lib/db/shops-pg";
import sql from "@/lib/db/postgres";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdminAuth() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }
  if (!["owner", "admin"].includes(session.role || "")) {
    return { error: "Forbidden - admin access required", status: 403 };
  }
  return { session };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const { searchParams } = new URL(req.url);
    const enterpriseId = searchParams.get("enterpriseId");
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }

    const enterprise = await getEnterpriseById(enterpriseId);
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    const shops = enterprise.shop_ids.length > 0 ? await sql`
      SELECT * FROM shops WHERE shop_id::int = ANY(${enterprise.shop_ids})
    ` : [];

    const shopUserCounts = enterprise.shop_ids.length > 0 ? await sql<{shop_id: string, count: string}[]>`
      SELECT shop_id, COUNT(*) as count FROM users 
      WHERE shop_id::int = ANY(${enterprise.shop_ids})
      GROUP BY shop_id
    ` : [];
    
    const userCountMap = new Map(shopUserCounts.map(s => [s.shop_id, parseInt(s.count, 10)]));

    const shopsWithUserCounts = shops.map(shop => ({
      id: shop.id,
      shopId: shop.shop_id ? parseInt(shop.shop_id, 10) : null,
      name: shop.name,
      locationIdentifier: shop.location_identifier,
      enterpriseId: shop.enterprise_id,
      userCount: userCountMap.get(shop.shop_id) || 0,
      tekmetric: shop.tekmetric,
      protractor: shop.protractor,
      billing: shop.billing,
      createdAt: shop.created_at,
      updatedAt: shop.updated_at,
    }));

    const availableUsers = enterprise.shop_ids.length > 0 ? await sql`
      SELECT DISTINCT ON (email) id, email, name, role 
      FROM users 
      WHERE shop_id::int = ANY(${enterprise.shop_ids})
      ORDER BY email
    ` : [];

    return NextResponse.json({ 
      enterprise: { id: enterprise.id, name: enterprise.name },
      shops: shopsWithUserCounts,
      availableUsers
    });
  } catch (err: unknown) {
    console.error("Enterprise shops GET error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  if (!["owner", "admin"].includes(session.role || "")) {
    return NextResponse.json({ error: "Only owners and admins can create locations" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const { enterpriseId, name, smsProvider, tekmetricShopId, protractorShopId, assignUserEmails } = body;
    
    if (!enterpriseId) {
      return NextResponse.json({ error: "Enterprise ID is required" }, { status: 400 });
    }
    
    if (!name) {
      return NextResponse.json({ error: "Shop name is required" }, { status: 400 });
    }

    const enterprise = await getEnterpriseById(enterpriseId);
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }
    
    if (!enterprise.shop_ids.includes(Number(session.shopId))) {
      return NextResponse.json({ error: "You don't have permission for this enterprise" }, { status: 403 });
    }

    const counterResult = await sql<{seq: number}[]>`
      INSERT INTO counters (id, seq) VALUES ('shopId', 10001)
      ON CONFLICT (id) DO UPDATE SET seq = counters.seq + 1
      RETURNING seq
    `;
    const shopId = counterResult[0]?.seq || 10001;

    const tekmetricConfig = smsProvider === "tekmetric" && tekmetricShopId 
      ? { shopId: tekmetricShopId } 
      : null;
    const protractorConfig = smsProvider === "protractor" && protractorShopId 
      ? { shopId: protractorShopId, enabled: true } 
      : null;

    const shop = await upsertShop({
      name: enterprise.name,
      shopId,
      enterpriseId,
      tekmetric: tekmetricConfig,
      protractor: protractorConfig,
      settings: { locationIdentifier: name.trim(), smsProvider: smsProvider || null },
    });

    await sql`
      UPDATE shops SET location_identifier = ${name.trim()}, webhook_token = ${crypto.randomBytes(12).toString("hex")}
      WHERE id = ${shop.id}
    `;

    await addShopToEnterprise(enterpriseId, shopId);

    if (assignUserEmails && assignUserEmails.length > 0) {
      const sourceUsers = await sql`
        SELECT DISTINCT ON (email) * FROM users
        WHERE email = ANY(${assignUserEmails.map((e: string) => e.toLowerCase())})
          AND shop_id::int = ANY(${enterprise.shop_ids})
      `;

      for (const user of sourceUsers) {
        const existing = await sql`
          SELECT id FROM users WHERE email = ${user.email} AND shop_id = ${String(shopId)} LIMIT 1
        `;
        
        if (existing.length === 0) {
          await sql`
            INSERT INTO users (id, email, name, password_hash, role, shop_id, created_at, updated_at)
            VALUES (gen_random_uuid(), ${user.email}, ${user.name}, ${user.password_hash}, ${user.role}, ${String(shopId)}, NOW(), NOW())
          `;
        }
      }
    }

    return NextResponse.json({
      shop: {
        id: shop.id,
        shopId,
        name: enterprise.name,
        locationIdentifier: name.trim(),
      }
    }, { status: 201 });
  } catch (err: unknown) {
    console.error("Enterprise shops POST error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdminAuth();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = await req.json();
    const { enterpriseId, shopId } = body;
    
    if (!enterpriseId || !shopId) {
      return NextResponse.json({ error: "Enterprise ID and Shop ID are required" }, { status: 400 });
    }

    const enterprise = await getEnterpriseById(enterpriseId);
    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    if (enterprise.shop_ids.length <= 1) {
      return NextResponse.json({ error: "Cannot remove the last shop from an enterprise" }, { status: 400 });
    }

    await removeShopFromEnterprise(enterpriseId, Number(shopId));

    await sql`
      UPDATE shops SET enterprise_id = NULL, updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;

    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    console.error("Enterprise shops DELETE error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
