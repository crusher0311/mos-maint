// app/api/cron/data-quality/route.ts
import { NextRequest, NextResponse } from "next/server";
import { runDataQualityCheck, autoCleanupData } from "@/lib/data-quality";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cron/data-quality
 * Cron job endpoint for automated data quality checks
 * Headers: { Authorization: "Bearer CRON_SECRET" }
 */
export async function POST(req: NextRequest) {
  try {
    // Verify cron secret
    const authHeader = req.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET || "default-cron-secret";
    
    if (!authHeader || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const results = [];

    // Get all active shops
    const shops = await db.collection("shops").find({}).toArray();

    for (const shop of shops) {
      try {
        console.log(`Running data quality check for shop ${shop.shopId}: ${shop.name}`);
        
        // Run quality check
        const report = await runDataQualityCheck(shop.shopId);
        
        // Auto-cleanup if enabled
        const autoCleanup = process.env.AUTO_CLEANUP_ENABLED === "true";
        let cleanupResult = null;
        
        if (autoCleanup) {
          cleanupResult = await autoCleanupData(shop.shopId, false); // Not dry run
        }

        // Wave 1 dual-write (task #342): PG canonical (must succeed) +
        // Mongo legacy best-effort mirror.
        const dqDoc = {
          shopId: shop.shopId,
          shopName: shop.name,
          report,
          cleanupResult,
          createdAt: new Date(),
          runType: "automated" as const,
        };
        const { pgInsertDataQualityReport } = await import("@/lib/db/repositories/wave1");
        await pgInsertDataQualityReport(dqDoc);
        try {
          await db.collection("data_quality_reports").insertOne(dqDoc);
        } catch (err) {
          console.error("[data-quality] Mongo mirror failed (non-fatal):", err);
        }

        results.push({
          shopId: shop.shopId,
          shopName: shop.name,
          issues: report.issues.length,
          cleaned: cleanupResult?.cleaned || 0,
          status: "success"
        });

        // Log critical issues
        const criticalIssues = report.issues.filter(i => i.severity === "critical");
        if (criticalIssues.length > 0) {
          console.warn(`Shop ${shop.shopId} has ${criticalIssues.length} critical data quality issues`);
        }

      } catch (error) {
        console.error(`Data quality check failed for shop ${shop.shopId}:`, error);
        results.push({
          shopId: shop.shopId,
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