import { NextRequest, NextResponse } from "next/server";
import { findAndResumeStaleBackfills, runProtractorBackfill } from "@/lib/integrations/protractor-backfill";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const host = req.headers.get("host") || "";
  const isLocalhost = host.startsWith("localhost") || host.startsWith("127.0.0.1");
  
  if (CRON_SECRET && !isLocalhost && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const shopIdParam = req.nextUrl.searchParams.get("shopId");
    
    if (shopIdParam) {
      const shopId = parseInt(shopIdParam, 10);
      console.log(`[Protractor Backfill Cron] Force-starting backfill for shop ${shopId}...`);
      
      await sql`
        INSERT INTO backfill_progress (shop_id, in_progress, updated_at)
        VALUES (${String(shopId)}, FALSE, NOW())
        ON CONFLICT (shop_id) DO UPDATE SET
          in_progress = FALSE,
          updated_at = NOW()
      `;
      
      runProtractorBackfill(shopId).then(result => {
        console.log(`[Protractor Backfill Cron] Shop ${shopId} backfill completed:`, result);
      }).catch(err => {
        console.error(`[Protractor Backfill Cron] Shop ${shopId} backfill failed:`, err.message);
      });
      
      return NextResponse.json({
        ok: true,
        message: `Backfill started for shop ${shopId}`,
        timestamp: new Date().toISOString(),
      });
    }
    
    console.log("[Protractor Backfill Cron] Checking for stale backfills...");
    
    const result = await findAndResumeStaleBackfills();
    
    console.log(`[Protractor Backfill Cron] Resumed ${result.resumed} stale backfills:`, result.shopIds);
    
    return NextResponse.json({
      ok: true,
      resumed: result.resumed,
      shopIds: result.shopIds,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Protractor Backfill Cron] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
