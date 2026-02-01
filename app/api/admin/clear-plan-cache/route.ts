import { NextResponse, NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  const session = await getSession();
  
  if (!session?.role || !["super_admin", "platform_admin"].includes(session.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sql`DELETE FROM cached_plans`;
    const deletedCount = result.count || 0;
    
    console.log(`[Admin] Cleared ${deletedCount} cached plans (by ${session.email})`);
    
    return NextResponse.json({ 
      ok: true, 
      cleared: deletedCount,
      message: `Cleared ${deletedCount} cached plans`
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Admin] Error clearing plan cache:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
