import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { runProtractorBackfill } from "@/lib/integrations/protractor-backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function requirePlatformAdmin() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }
  if (!session.isPlatformAdmin) {
    return { error: "Platform admin access required", status: 403 };
  }
  return { session };
}

function detectIntegrationType(shop: any): "protractor" | "tekmetric" | null {
  if (shop.integrationProvider === "tekmetric") return "tekmetric";
  if (shop.integrationProvider === "protractor") return "protractor";

  const hasTekmetric = !!(shop.tekmetric?.shopId || shop.tekmetricShopId);
  const hasProtractor = !!(
    shop.protractor?.configured ||
    shop.protractor?.apiKey ||
    shop.protractor?.connectionId ||
    shop.protractorApiKey ||
    shop.protractorConnectionId
  );
  
  if (hasTekmetric) return "tekmetric";
  if (hasProtractor) return "protractor";
  return null;
}

async function triggerTekmetricBackfill(shopId: number): Promise<{ ok: boolean; message: string }> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId });
  const tekmetricShopId = shop?.tekmetric?.shopId || shop?.tekmetricShopId;
  
  if (!tekmetricShopId) {
    return { ok: false, message: "No Tekmetric shop ID found" };
  }

  const now = new Date();
  now.setHours(23, 59, 59, 999);

  await db.collection("tekmetric_backfill_progress").updateOne(
    { shopId },
    { 
      $set: { 
        shopId,
        completed: false,
        inProgress: false,
        currentChunkEnd: now,
        queuedAt: new Date(),
        logicVersion: 2
      },
      $setOnInsert: { startedAt: null }
    },
    { upsert: true }
  );

  await db.collection("shops").updateOne(
    { shopId },
    { $set: { tekmetricBackfillComplete: false } }
  );

  try {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5000";
    
    fetch(`${baseUrl}/api/cron/tekmetric-backfill`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ shopId }),
    }).catch(err => {
      console.log(`[Platform Admin] Tekmetric backfill trigger note: ${err.message}`);
    });
  } catch (e) {
    // fire-and-forget
  }

  console.log(`[Platform Admin] Triggered full Tekmetric backfill for shop ${shopId} (tekmetricShopId: ${tekmetricShopId})`);
  return { ok: true, message: `Tekmetric full backfill triggered for shop ${shopId}` };
}

export async function POST(req: NextRequest) {
  const auth = await requirePlatformAdmin();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const { shopId, action } = await req.json();
    const db = await getDb();

    if (action === "resume_all_incomplete") {
      console.log("[Platform Admin] Finding all incomplete backfills (Protractor + Tekmetric)...");
      
      const allIntegrationShops = await db.collection("shops")
        .find({
          $or: [
            { "protractor.configured": true },
            { "protractor.apiKey": { $exists: true } },
            { "protractorApiKey": { $exists: true } },
            { "protractorConnectionId": { $exists: true } },
            { "tekmetric.shopId": { $exists: true, $ne: null } },
            { "tekmetricShopId": { $exists: true, $ne: null } }
          ]
        })
        .project({ shopId: 1, name: 1, integrationProvider: 1, protractor: 1, protractorApiKey: 1, protractorConnectionId: 1, tekmetric: 1, tekmetricShopId: 1, tekmetricBackfillComplete: 1 })
        .toArray();
      
      const protractorShops: any[] = [];
      const tekmetricShops: any[] = [];
      for (const shop of allIntegrationShops) {
        const type = detectIntegrationType(shop);
        if (type === "protractor") protractorShops.push(shop);
        else if (type === "tekmetric") tekmetricShops.push(shop);
      }
      
      const allBackfillProgress = await db.collection("backfill_progress")
        .find({})
        .toArray();
      
      const fiveYearsAgo = new Date();
      fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
      fiveYearsAgo.setMonth(fiveYearsAgo.getMonth() + 1);
      
      const actuallyCompleteProtractorIds = new Set<number>();
      for (const progress of allBackfillProgress) {
        if (progress.completed && progress.currentChunkEnd) {
          const chunkEnd = new Date(progress.currentChunkEnd);
          if (chunkEnd <= fiveYearsAgo) {
            actuallyCompleteProtractorIds.add(progress.shopId);
          } else {
            console.log(`[Platform Admin] Protractor shop ${progress.shopId} marked complete but only at ${chunkEnd.toISOString().split('T')[0]} - will resume`);
            await db.collection("backfill_progress").updateOne(
              { shopId: progress.shopId },
              { $set: { completed: false } }
            );
          }
        }
      }
      
      const incompleteProtractor = protractorShops.filter((s: any) => !actuallyCompleteProtractorIds.has(s.shopId));
      
      const tekmetricBackfillProgress = await db.collection("tekmetric_backfill_progress")
        .find({})
        .toArray();
      const completeTekmetricIds = new Set<number>();
      for (const progress of tekmetricBackfillProgress) {
        if (progress.completed && progress.logicVersion === 2) {
          completeTekmetricIds.add(progress.shopId);
        }
      }
      const incompleteTekmetric = tekmetricShops.filter((s: any) => 
        !completeTekmetricIds.has(s.shopId) && !s.tekmetricBackfillComplete
      );
      
      console.log(`[Platform Admin] Found ${incompleteProtractor.length} incomplete Protractor backfills (${actuallyCompleteProtractorIds.size} complete)`);
      console.log(`[Platform Admin] Found ${incompleteTekmetric.length} incomplete Tekmetric backfills (${completeTekmetricIds.size} complete)`);
      
      const resumedProtractor: number[] = [];
      const resumedTekmetric: number[] = [];
      
      await Promise.all(
        incompleteProtractor.map(shop => 
          db.collection("backfill_progress").updateOne(
            { shopId: shop.shopId },
            { $set: { inProgress: false } }
          )
        )
      );
      
      for (const shop of incompleteProtractor) {
        resumedProtractor.push(shop.shopId);
        runProtractorBackfill(shop.shopId).catch(err => {
          console.error(`[Platform Admin] Protractor backfill error for shop ${shop.shopId}:`, err.message);
        });
      }
      
      for (const shop of incompleteTekmetric) {
        resumedTekmetric.push(shop.shopId);
        triggerTekmetricBackfill(shop.shopId).catch(err => {
          console.error(`[Platform Admin] Tekmetric backfill error for shop ${shop.shopId}:`, err);
        });
      }
      
      const totalResumed = resumedProtractor.length + resumedTekmetric.length;
      console.log(`[Platform Admin] Started ${totalResumed} backfills (${resumedProtractor.length} Protractor, ${resumedTekmetric.length} Tekmetric)`);
      
      return NextResponse.json({
        ok: true,
        message: `Resumed ${totalResumed} backfills (${resumedProtractor.length} Protractor, ${resumedTekmetric.length} Tekmetric)`,
        protractorShopIds: resumedProtractor,
        tekmetricShopIds: resumedTekmetric,
        totalResumed
      });
    }
    
    if (!shopId) {
      return NextResponse.json({ error: "Shop ID is required" }, { status: 400 });
    }

    const numericShopId = Number(shopId);
    const shop = await db.collection("shops").findOne({ shopId: numericShopId });
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const integrationType = detectIntegrationType(shop);

    if (action === "resume") {
      if (!integrationType) {
        return NextResponse.json({ error: "Shop does not have any SMS integration configured" }, { status: 400 });
      }

      console.log(`[Platform Admin] Triggering ${integrationType} backfill for shop ${numericShopId}`);

      if (integrationType === "protractor") {
        runProtractorBackfill(numericShopId).catch(err => {
          console.error(`[Platform Admin] Protractor backfill error for shop ${numericShopId}:`, err.message);
        });
        return NextResponse.json({ 
          ok: true, 
          message: `Protractor backfill resumed for shop ${numericShopId}`,
          source: "protractor"
        });
      } else {
        const result = await triggerTekmetricBackfill(numericShopId);
        return NextResponse.json({ 
          ok: result.ok, 
          message: result.message,
          source: "tekmetric"
        });
      }
    }

    if (action === "reset") {
      console.log(`[Platform Admin] Resetting backfill progress for shop ${numericShopId} (${integrationType || "unknown"})`);
      
      if (integrationType === "tekmetric") {
        await Promise.all([
          db.collection("tekmetric_backfill_progress").deleteOne({ shopId: numericShopId }),
          db.collection("shops").updateOne(
            { shopId: numericShopId },
            { $unset: { tekmetricBackfillComplete: "", tekmetricBackfillCompletedAt: "" } }
          )
        ]);
      } else {
        await db.collection("backfill_progress").deleteOne({ shopId: numericShopId });
      }
      
      return NextResponse.json({ 
        ok: true, 
        message: `Backfill progress reset for shop ${numericShopId} (${integrationType || "unknown"})` 
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    console.error("[Platform Admin] Backfill error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
