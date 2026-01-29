import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  
  if (!session?.role || !["super_admin", "platform_admin"].includes(session.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = await getDb();
    const result = await db.collection("cached_plans").deleteMany({});
    
    console.log(`[Admin] Cleared ${result.deletedCount} cached plans (by ${session.email})`);
    
    return NextResponse.json({ 
      ok: true, 
      cleared: result.deletedCount,
      message: `Cleared ${result.deletedCount} cached plans`
    });
  } catch (error: any) {
    console.error("[Admin] Error clearing plan cache:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
