import { NextRequest, NextResponse } from "next/server";
import { runDataQualityCheck, autoCleanupData } from "@/lib/data-quality";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET || "default-cron-secret";
    
    if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const results: any[] = [];

    const shops = await sql`SELECT * FROM shops`;

    for (const shop of shops) {
      try {
        console.log(`Running data quality check for shop ${shop.shop_id}: ${shop.name}`);
        
        const report = await runDataQualityCheck(Number(shop.shop_id));
        
        const autoCleanup = process.env.AUTO_CLEANUP_ENABLED === "true";
        let cleanupResult = null;
        
        if (autoCleanup) {
          cleanupResult = await autoCleanupData(Number(shop.shop_id), false);
        }

        await sql`
          INSERT INTO data_quality_reports (shop_id, shop_name, report, cleanup_result, created_at, run_type)
          VALUES (${shop.shop_id}, ${shop.name}, ${JSON.stringify(report)}::jsonb, ${cleanupResult ? JSON.stringify(cleanupResult) : null}::jsonb, ${new Date()}, 'automated')
        `;

        results.push({
          shopId: shop.shop_id,
          shopName: shop.name,
          issues: report.issues.length,
          cleaned: cleanupResult?.cleaned || 0,
          status: "success"
        });

        const criticalIssues = report.issues.filter((i: any) => i.severity === "critical");
        if (criticalIssues.length > 0) {
          console.warn(`Shop ${shop.shop_id} has ${criticalIssues.length} critical data quality issues`);
        }

      } catch (error: any) {
        console.error(`Data quality check failed for shop ${shop.shop_id}:`, error);
        results.push({
          shopId: shop.shop_id,
          shopName: shop.name,
          status: "error",
          error: error.message
        });
      }
    }

    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      shopsProcessed: shops.length,
      results,
      summary: {
        successful: results.filter(r => r.status === "success").length,
        failed: results.filter(r => r.status === "error").length,
        totalIssues: results.reduce((sum, r) => sum + (r.issues || 0), 0),
        totalCleaned: results.reduce((sum, r) => sum + (r.cleaned || 0), 0)
      }
    });

  } catch (error: any) {
    console.error("Cron data quality check error:", error);
    return NextResponse.json({ 
      error: error.message || "Cron job failed" 
    }, { status: 500 });
  }
}
