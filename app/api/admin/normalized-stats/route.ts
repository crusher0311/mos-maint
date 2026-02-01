import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = String(session.shopId);
  
  const shopResult = await sql`
    SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1
  `;
  const shop = shopResult[0];
  const settings = shop?.settings as Record<string, unknown> | null;
  
  if (!settings?.platformAdmin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const tables = [
    'normalized_vehicles',
    'normalized_customers',
    'normalized_work_orders',
    'normalized_service_jobs',
    'normalized_payments',
    'normalized_inspections',
    'normalized_recommendations',
  ];

  const stats: Record<string, { total: number; bySource: Record<string, number>; last24Hours: number }> = {};
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const tableName of tables) {
    try {
      const totalResult = await sql.unsafe(`SELECT COUNT(*) as count FROM ${tableName} WHERE deleted_at IS NULL`);
      const total = Number(totalResult[0]?.count || 0);

      const bySourceResult = await sql.unsafe(`
        SELECT provenance->>'sourceSystem' as source, COUNT(*) as count 
        FROM ${tableName} WHERE deleted_at IS NULL 
        GROUP BY provenance->>'sourceSystem'
      `);
      
      const bySource: Record<string, number> = {};
      for (const item of bySourceResult) {
        bySource[item.source || 'unknown'] = Number(item.count);
      }

      const recentResult = await sql.unsafe(`
        SELECT COUNT(*) as count FROM ${tableName} 
        WHERE deleted_at IS NULL AND created_at >= $1
      `, [yesterday]);
      const recentCount = Number(recentResult[0]?.count || 0);

      stats[tableName] = {
        total,
        bySource,
        last24Hours: recentCount,
      };
    } catch {
      stats[tableName] = { total: 0, bySource: {}, last24Hours: 0 };
    }
  }

  const jobIndexResult = await sql`SELECT COUNT(*) as count FROM job_index`;
  const jobIndexCount = Number(jobIndexResult[0]?.count || 0);
  
  const coverageByShop = await sql`
    SELECT shop_id, COUNT(*) as count FROM normalized_work_orders 
    WHERE deleted_at IS NULL 
    GROUP BY shop_id ORDER BY count DESC LIMIT 20
  `;

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    stats,
    legacy_job_index: { total: jobIndexCount },
    coverageByShop: coverageByShop.map(s => ({ shopId: s.shop_id, workOrders: Number(s.count) })),
  });
}
