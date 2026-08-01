import { NextResponse, NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import {
  clearTemplateCache,
  templateCacheStats,
} from "@/lib/data/repositories/protractor-template-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  
  if (!session?.role || !["super_admin", "platform_admin"].includes(session.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const shopId = body.shopId ? Number(body.shopId) : null;
    const clear404sOnly = body.clear404sOnly === true;
    
    const cleared = await clearTemplateCache({ shopId, clear404sOnly });
    
    const desc = shopId 
      ? `shop ${shopId}${clear404sOnly ? " (404s only)" : ""}` 
      : clear404sOnly ? "all 404s" : "all shops";
    
    console.log(`[Admin] Cleared ${cleared} template cache entries for ${desc} (by ${session.email})`);
    
    return NextResponse.json({ 
      ok: true, 
      cleared,
      message: `Cleared ${cleared} cached templates for ${desc}`
    });
  } catch (error: any) {
    console.error("[Admin] Error clearing template cache:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function GET() {
  const session = await getSession();
  
  if (!session?.role || !["super_admin", "platform_admin"].includes(session.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const stats = await templateCacheStats();
    
    const totals = stats.reduce((acc, s) => ({
      total: acc.total + s.total,
      cached: acc.cached + s.cached,
      notFound: acc.notFound + s.notFound
    }), { total: 0, cached: 0, notFound: 0 });
    
    return NextResponse.json({ 
      ok: true, 
      totals,
      byShop: stats.map(s => ({
        shopId: s.shopId,
        total: s.total,
        cached: s.cached,
        notFound: s.notFound
      }))
    });
  } catch (error: any) {
    console.error("[Admin] Error getting template cache stats:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
