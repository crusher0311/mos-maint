import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [enterprises, shops] = await Promise.all([
      sql`SELECT * FROM enterprise_accounts`,
      sql`SELECT id, shop_id, name, enterprise_id FROM shops`
    ]);

    const enrichedEnterprises = enterprises.map(e => ({
      _id: e.id,
      name: e.name,
      shopIds: e.shop_ids || [],
      shopCount: e.shop_ids?.length || 0,
      createdAt: e.created_at,
    }));

    const availableShops = shops.filter(s => !s.enterprise_id).map(s => ({
      shopId: s.shop_id ? parseInt(s.shop_id, 10) : null,
      name: s.name,
    }));

    return NextResponse.json({
      ok: true,
      enterprises: enrichedEnterprises,
      availableShops,
      allShops: shops.map(s => ({ 
        shopId: s.shop_id ? parseInt(s.shop_id, 10) : null, 
        name: s.name, 
        enterpriseId: s.enterprise_id 
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Platform admin enterprises error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { name, shopIds } = await req.json();

    if (!name?.trim()) {
      return NextResponse.json({ error: "Enterprise name is required" }, { status: 400 });
    }

    const now = new Date();
    
    const result = await sql`
      INSERT INTO enterprise_accounts (name, shop_ids, created_at, created_by)
      VALUES (${name.trim()}, ${shopIds || []}, ${now}, ${session.email})
      RETURNING id
    `;
    
    const enterpriseId = result[0].id;

    if (shopIds?.length > 0) {
      await sql`
        UPDATE shops 
        SET enterprise_id = ${enterpriseId}, updated_at = ${now}
        WHERE shop_id = ANY(${shopIds.map(String)})
      `;
    }

    await sql`
      INSERT INTO audit_logs (type, enterprise_id, metadata, admin_email, created_at)
      VALUES (
        'enterprise_created', 
        ${enterpriseId}, 
        ${JSON.stringify({ enterpriseName: name, shopIds })}::jsonb, 
        ${session.email}, 
        ${now}
      )
    `;

    return NextResponse.json({
      ok: true,
      enterprise: { _id: enterpriseId, name: name.trim(), shopIds: shopIds || [], createdAt: now },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Create enterprise error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
