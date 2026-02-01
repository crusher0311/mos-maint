import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const admin = req.headers.get("x-admin-token");
  if (!admin) return NextResponse.json({ error: "Missing X-Admin-Token" }, { status: 401 });

  try {
    const indexes = await sql`
      SELECT 
        schemaname,
        tablename,
        indexname,
        indexdef
      FROM pg_indexes 
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `;

    const counterResult = await sql`
      SELECT * FROM counters WHERE id = 'shopId' LIMIT 1
    `;
    const counter = counterResult[0];

    const maxShopResult = await sql`
      SELECT MAX(CAST(shop_id AS INTEGER)) as max_id FROM shops WHERE shop_id ~ '^[0-9]+$'
    `;
    const maxExisting = maxShopResult[0]?.max_id || 0;

    return NextResponse.json({
      ok: true,
      note: "PostgreSQL indexes are managed by schema migrations",
      indexCount: indexes.length,
      indexes: indexes.slice(0, 50).map(i => ({
        table: i.tablename,
        name: i.indexname,
        definition: i.indexdef
      })),
      counter,
      maxExisting,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
