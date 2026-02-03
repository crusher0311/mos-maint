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
    const body = await req.json().catch(() => ({}));
    const shopId = body.shopId ? Number(body.shopId) : null;
    const clear404sOnly = body.clear404sOnly === true;
    
    const db = await getDb();
    
    const filter: Record<string, any> = {};
    if (shopId) filter.shopId = shopId;
    if (clear404sOnly) filter.is404 = true;
    
    const result = await db.collection("protractor_template_cache").deleteMany(filter);
    
    const desc = shopId 
      ? `shop ${shopId}${clear404sOnly ? " (404s only)" : ""}` 
      : clear404sOnly ? "all 404s" : "all shops";
    
    console.log(`[Admin] Cleared ${result.deletedCount} template cache entries for ${desc} (by ${session.email})`);
    
    return NextResponse.json({ 
      ok: true, 
      cleared: result.deletedCount,
      message: `Cleared ${result.deletedCount} cached templates for ${desc}`
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
    const db = await getDb();
    
    const stats = await db.collection("protractor_template_cache").aggregate([
      {
        $group: {
          _id: { shopId: "$shopId", is404: "$is404" },
          count: { $sum: 1 }
        }
      },
      {
        $group: {
          _id: "$_id.shopId",
          total: { $sum: "$count" },
          cached: { 
            $sum: { $cond: [{ $eq: ["$_id.is404", false] }, "$count", 0] }
          },
          notFound: { 
            $sum: { $cond: [{ $eq: ["$_id.is404", true] }, "$count", 0] }
          }
        }
      },
      { $sort: { total: -1 } }
    ]).toArray();
    
    const totals = stats.reduce((acc, s) => ({
      total: acc.total + s.total,
      cached: acc.cached + s.cached,
      notFound: acc.notFound + s.notFound
    }), { total: 0, cached: 0, notFound: 0 });
    
    return NextResponse.json({ 
      ok: true, 
      totals,
      byShop: stats.map(s => ({
        shopId: s._id,
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
