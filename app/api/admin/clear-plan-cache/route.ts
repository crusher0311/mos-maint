import { NextResponse, NextRequest } from "next/server";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  
  if (!session?.role || !["super_admin", "platform_admin"].includes(session.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Task #998: clears BOTH stores (Mongo + PG) via the facade.
    const { deleteAllCachedPlans } = await import(
      "@/lib/data/repositories/plan-cache-store"
    );
    const cleared = await deleteAllCachedPlans();

    console.log(`[Admin] Cleared ${cleared} cached plans (by ${session.email})`);

    return NextResponse.json({ 
      ok: true, 
      cleared,
      message: `Cleared ${cleared} cached plans`
    });
  } catch (error: any) {
    console.error("[Admin] Error clearing plan cache:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
