import { NextRequest, NextResponse } from "next/server";
import { findAndResumeStaleBackfills, runProtractorBackfill } from "@/lib/integrations/protractor-backfill";
import { getDb } from "@/lib/mongo";

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
      
      const db = await getDb();
      await db.collection("backfill_progress").updateOne(
        { shopId },
        { $set: { inProgress: false } }
      );

      // `?wait=1` opts in to synchronous execution so the platform-admin
      // "Run chunk now" endpoint can surface chunk metrics inline. The
      // default fire-and-forget path is kept for the existing manual-trigger
      // contract (e.g. settings flows) so we don't change behavior for any
      // caller that just wants to kick the queue and move on.
      const waitForResult = req.nextUrl.searchParams.get("wait") === "1";
      if (waitForResult) {
        try {
          // Run a single bounded pass (no self-recursion, no auto-retry
          // chain) so the inline response always fits within the route's
          // `maxDuration` budget. The on-call engineer can re-click if
          // they need more chunks.
          const result = await runProtractorBackfill(shopId, { singlePass: true });
          // A `result.error` here means the single-pass run failed inside
          // the backfill (or was already in progress). Surface that as a
          // non-ok JSON response so the run-now endpoint and the admin UI
          // both treat it as an error path consistently with the
          // Tekmetric/Shop-Ware crons (which return non-ok for failed runs).
          if (result.error) {
            return NextResponse.json(
              {
                ok: false,
                error: `Backfill ran with error for shop ${shopId}: ${result.error}`,
                result,
                timestamp: new Date().toISOString(),
              },
              { status: 500 }
            );
          }
          return NextResponse.json({
            ok: true,
            message: `Backfill ${result.complete ? "completed" : "ran"} for shop ${shopId} (${result.chunksProcessed} chunk${result.chunksProcessed === 1 ? "" : "s"})`,
            result,
            timestamp: new Date().toISOString(),
          });
        } catch (err: any) {
          console.error(`[Protractor Backfill Cron] Shop ${shopId} sync backfill failed:`, err?.message || err);
          return NextResponse.json(
            {
              ok: false,
              error: err?.message || "Protractor backfill failed",
              timestamp: new Date().toISOString(),
            },
            { status: 500 }
          );
        }
      }

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
