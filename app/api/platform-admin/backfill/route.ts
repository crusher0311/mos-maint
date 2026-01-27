import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { runProtractorBackfill } from "@/lib/integrations/protractor-backfill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requirePlatformAdmin() {
  const session = await getSession();
  if (!session) {
    return { error: "Unauthorized", status: 401 };
  }
  if (session.role !== "admin") {
    return { error: "Platform admin access required", status: 403 };
  }
  return { session };
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
      console.log("[Platform Admin] Finding all incomplete backfills...");
      
      const protractorShops = await db.collection("shops")
        .find({ "protractor.configured": true })
        .project({ shopId: 1, name: 1 })
        .toArray();
      
      const backfillProgress = await db.collection("backfill_progress")
        .find({ completed: true })
        .project({ shopId: 1 })
        .toArray();
      
      const completedShopIds = new Set(backfillProgress.map((b: any) => b.shopId));
      const incompleteShops = protractorShops.filter((s: any) => !completedShopIds.has(s.shopId));
      
      console.log(`[Platform Admin] Found ${incompleteShops.length} shops with incomplete backfills`);
      
      const resumedShopIds: number[] = [];
      for (const shop of incompleteShops) {
        await db.collection("backfill_progress").updateOne(
          { shopId: shop.shopId },
          { $set: { inProgress: false } }
        );
        
        runProtractorBackfill(shop.shopId).catch(err => {
          console.error(`[Platform Admin] Backfill error for shop ${shop.shopId}:`, err.message);
        });
        
        resumedShopIds.push(shop.shopId);
      }
      
      return NextResponse.json({
        ok: true,
        message: `Resumed backfill for ${resumedShopIds.length} shops`,
        shopIds: resumedShopIds
      });
    }
    
    if (!shopId) {
      return NextResponse.json({ error: "Shop ID is required" }, { status: 400 });
    }

    const numericShopId = Number(shopId);

    if (action === "resume") {
      const shop = await db.collection("shops").findOne({ shopId: numericShopId });
      if (!shop) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 });
      }

      const hasProtractor = !!shop.protractor?.connectionId;
      
      if (!hasProtractor) {
        return NextResponse.json({ error: "Shop does not have Protractor configured" }, { status: 400 });
      }

      console.log(`[Platform Admin] Triggering backfill resume for shop ${numericShopId}`);
      
      runProtractorBackfill(numericShopId).catch(err => {
        console.error(`[Platform Admin] Backfill error for shop ${numericShopId}:`, err.message);
      });

      return NextResponse.json({ 
        ok: true, 
        message: `Backfill resumed for shop ${numericShopId}` 
      });
    }

    if (action === "reset") {
      console.log(`[Platform Admin] Resetting backfill progress for shop ${numericShopId}`);
      
      await db.collection("backfill_progress").deleteOne({ shopId: numericShopId });
      
      return NextResponse.json({ 
        ok: true, 
        message: `Backfill progress reset for shop ${numericShopId}` 
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    console.error("[Platform Admin] Backfill error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
