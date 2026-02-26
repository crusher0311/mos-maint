import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;

function getSql() {
  if (!_sql) {
    const connStr = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL!;
    _sql = postgres(connStr, {
      connect_timeout: 30,
      idle_timeout: 20,
    });
  }
  return _sql;
}

export async function GET() {
  try {
    await requirePlatformAdmin();
    const sql = getSql();

    const rows = await sql`
      SELECT DISTINCT maintenance_name, maintenance_category 
      FROM dataone_def_maintenance 
      ORDER BY maintenance_category, maintenance_name
    `;

    const names = rows.map((r: any) => ({
      name: r.maintenance_name,
      category: r.maintenance_category
    }));

    return NextResponse.json({ ok: true, names });
  } catch (error: any) {
    if (error.message?.includes("Unauthorized")) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    console.error("[Service Mappings] Error fetching OEM names:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
