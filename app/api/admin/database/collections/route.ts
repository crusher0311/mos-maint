import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function GET(_req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const tables = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;

    const collections = tables.map(t => ({
      name: t.table_name,
      count: null
    }));

    return NextResponse.json({ collections });
  } catch (error) {
    console.error("Failed to list tables:", error);
    return NextResponse.json({ error: "Failed to list tables" }, { status: 500 });
  }
}
