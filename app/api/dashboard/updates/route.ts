import { NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const updateResult = await sql`
      SELECT timestamp FROM dashboard_updates WHERE id = 'lastUpdate' LIMIT 1
    `;
    
    return NextResponse.json({ 
      lastUpdate: updateResult[0]?.timestamp || 0 
    });
  } catch {
    return NextResponse.json({ lastUpdate: 0 });
  }
}
