import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { validateShopAccess } from "@/lib/integrations/tekmetric";
import { syncSingleShop } from "@/lib/tekmetric-sync";

async function triggerJobHistoryBackfill(shopId: number) {
  try {
    const db = await getDb();
    await db.collection("tekmetric_backfill_progress").updateOne(
      { shopId },
      { 
        $set: { 
          shopId, 
          queuedAt: new Date(),
          completed: false,
          logicVersion: 2
        },
        $setOnInsert: { startedAt: null }
      },
      { upsert: true }
    );
    
    await db.collection("shops").updateOne(
      { shopId: { $in: [shopId, String(shopId)] } },
      { $set: { tekmetricBackfillComplete: false } }
    );
    
    console.log(`[Tekmetric Settings] Queued job history backfill for shop ${shopId}`);
  } catch (err: any) {
    console.error(`[Tekmetric Settings] Failed to queue backfill for shop ${shopId}:`, err.message);
  }
}

async function getUserShopId(): Promise<string | null> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return null;

  const db = await getDb();
  const now = new Date();
  const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: now } });
  if (!sess) return null;

  const user = await db.collection("users").findOne({ _id: sess.userId });
  return user?.shopId ? String(user.shopId) : null;
}

export async function GET(request: NextRequest) {
  try {
    const shopId = await getUserShopId();
    if (!shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    
    const shop = await db.collection("shops").findOne({
      shopId: { $in: [shopId, Number(shopId)] }
    });
    
    if (!shop?.tekmetric?.shopId) {
      return NextResponse.json({
        configured: false,
        shopId: null,
        shopName: null,
      });
    }

    return NextResponse.json({
      configured: true,
      shopId: shop.tekmetric.shopId,
      shopName: shop.tekmetric.shopName,
      lastSync: shop.tekmetric.lastSync,
    });
  } catch (error: any) {
    console.error("Error fetching Tekmetric settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to fetch settings" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const userShopId = await getUserShopId();
    if (!userShopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { shopId } = body;

    if (!shopId) {
      return NextResponse.json(
        { error: "Shop ID is required" },
        { status: 400 }
      );
    }

    const tekmetricShopId = parseInt(shopId, 10);
    if (isNaN(tekmetricShopId)) {
      return NextResponse.json(
        { error: "Shop ID must be a number" },
        { status: 400 }
      );
    }

    if (!process.env.TEKMETRIC_CLIENT_ID || !process.env.TEKMETRIC_CLIENT_SECRET) {
      return NextResponse.json(
        { error: "Tekmetric API credentials not configured. Please contact support." },
        { status: 500 }
      );
    }

    const validation = await validateShopAccess(tekmetricShopId);
    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error || "Unable to access shop" },
        { status: 400 }
      );
    }

    const db = await getDb();

    await db.collection("shops").updateOne(
      { shopId: { $in: [userShopId, Number(userShopId)] } },
      {
        $set: {
          "tekmetric.shopId": tekmetricShopId,
          "tekmetric.shopName": validation.shop?.name,
          "tekmetric.connectedAt": new Date(),
        },
      },
      { upsert: true }
    );

    let syncResult: { success: boolean; synced: number; error?: string } = { success: false, synced: 0 };
    try {
      syncResult = await syncSingleShop(userShopId, tekmetricShopId);
    } catch (syncErr: any) {
      console.error("[Tekmetric Settings] Initial sync failed:", syncErr.message);
      syncResult.error = syncErr.message;
    }

    // Queue the 5-year job history backfill (runs via cron)
    triggerJobHistoryBackfill(Number(userShopId)).catch(() => {});

    return NextResponse.json({
      success: true,
      shopId: tekmetricShopId,
      shopName: validation.shop?.name,
      initialSync: {
        completed: syncResult.success,
        vehiclesSynced: syncResult.synced,
        error: syncResult.error
      },
      jobHistoryBackfill: "queued"
    });
  } catch (error: any) {
    console.error("Error saving Tekmetric settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to save settings" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const userShopId = await getUserShopId();
    if (!userShopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();

    await db.collection("shops").updateOne(
      { shopId: { $in: [userShopId, Number(userShopId)] } },
      { $unset: { tekmetric: "" } }
    );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Error disconnecting Tekmetric:", error);
    return NextResponse.json(
      { error: error.message || "Failed to disconnect" },
      { status: 500 }
    );
  }
}
