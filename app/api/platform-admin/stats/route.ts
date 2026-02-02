import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cachedStats: { totalRequests: number; totalCost: number; cachedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const [shopCountResult, userCountResult, recentShopsResult] = await Promise.all([
      sql<{count: string}[]>`SELECT COUNT(*) as count FROM shops`,
      sql<{count: string}[]>`SELECT COUNT(*) as count FROM users`,
      sql`SELECT id, shop_id, name, created_at FROM shops ORDER BY created_at DESC NULLS LAST LIMIT 5`
    ]);
    
    const totalShops = parseInt(shopCountResult[0]?.count || "0", 10);
    const totalUsers = parseInt(userCountResult[0]?.count || "0", 10);
    const recentShops = recentShopsResult.map(s => ({
      shopId: s.shop_id ? parseInt(s.shop_id, 10) : null,
      name: s.name,
      createdAt: s.created_at
    }));
    
    let usage = { totalRequests: 0, totalCost: 0 };
    const now = Date.now();
    
    if (cachedStats && (now - cachedStats.cachedAt) < CACHE_TTL_MS) {
      usage = { totalRequests: cachedStats.totalRequests, totalCost: cachedStats.totalCost };
    } else {
      try {
        const requestCountResult = await sql<{count: string}[]>`SELECT COUNT(*) as count FROM usage_logs`;
        const totalRequests = parseInt(requestCountResult[0]?.count || "0", 10);
        const totalCost = 0; // Cost tracking not implemented yet
        
        cachedStats = {
          totalRequests,
          totalCost,
          cachedAt: Date.now()
        };
        
        usage = { totalRequests, totalCost };
      } catch {
        // Table may not exist
        usage = { totalRequests: 0, totalCost: 0 };
      }
    }
    
    return NextResponse.json({
      ok: true,
      totalShops,
      totalUsers,
      totalRequests: usage.totalRequests,
      totalCost: usage.totalCost,
      recentShops,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Platform stats error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
