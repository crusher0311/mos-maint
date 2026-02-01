import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search") || "";
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = (page - 1) * limit;

    let shops;
    let totalResult;

    if (search) {
      const searchPattern = `%${search}%`;
      shops = await sql`
        SELECT * FROM shops 
        WHERE name ILIKE ${searchPattern} OR shop_id ILIKE ${searchPattern}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      totalResult = await sql`
        SELECT COUNT(*) as count FROM shops 
        WHERE name ILIKE ${searchPattern} OR shop_id ILIKE ${searchPattern}
      `;
    } else {
      shops = await sql`
        SELECT * FROM shops ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
      totalResult = await sql`SELECT COUNT(*) as count FROM shops`;
    }

    const total = Number(totalResult[0]?.count || 0);

    const shopsWithStats = await Promise.all(
      shops.map(async (shop) => {
        const shopId = shop.shop_id;
        const [userCount, customerCount, vehicleCount, eventCount] = await Promise.all([
          sql`SELECT COUNT(*) as count FROM users WHERE shop_id = ${shopId}`,
          sql`SELECT COUNT(*) as count FROM customers WHERE shop_id = ${shopId}`,
          sql`SELECT COUNT(*) as count FROM vehicles WHERE shop_id = ${shopId}`,
          sql`SELECT COUNT(*) as count FROM events WHERE shop_id = ${shopId}`,
        ]);

        const lastActivityResult = await sql`
          SELECT received_at FROM events WHERE shop_id = ${shopId} ORDER BY received_at DESC LIMIT 1
        `;

        return {
          ...shop,
          shopId: shop.shop_id,
          stats: {
            users: Number(userCount[0]?.count || 0),
            customers: Number(customerCount[0]?.count || 0),
            vehicles: Number(vehicleCount[0]?.count || 0),
            events: Number(eventCount[0]?.count || 0),
            lastActivity: lastActivityResult[0]?.received_at || null
          }
        };
      })
    );

    return NextResponse.json({
      shops: shopsWithStats,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error("Admin shops API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { name, contactEmail, autoflowConfig } = body;

    if (!name) {
      return NextResponse.json({ error: "Shop name is required" }, { status: 400 });
    }

    const counterResult = await sql`
      INSERT INTO counters (id, seq) VALUES ('shopId', 10001)
      ON CONFLICT (id) DO UPDATE SET seq = counters.seq + 1
      RETURNING seq
    `;
    const shopId = String(counterResult[0]?.seq || 10001);

    const webhookToken = crypto.randomBytes(12).toString("hex");
    const now = new Date();
    
    const autoflowConfigJson = autoflowConfig ? JSON.stringify(autoflowConfig) : null;

    const result = await sql`
      INSERT INTO shops (shop_id, name, contact_email, webhook_token, status, autoflow_config, created_at, updated_at)
      VALUES (${shopId}, ${name.trim()}, ${contactEmail?.trim() || null}, ${webhookToken}, 'active', ${autoflowConfigJson}::jsonb, ${now}, ${now})
      RETURNING *
    `;

    return NextResponse.json({
      shop: {
        ...result[0],
        shopId: result[0].shop_id
      }
    }, { status: 201 });

  } catch (error) {
    console.error("Admin create shop error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
