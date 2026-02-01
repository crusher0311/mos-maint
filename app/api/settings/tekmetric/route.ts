import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";
import { validateShopAccess } from "@/lib/tekmetric";
import { syncSingleShop } from "@/lib/tekmetric-sync";

async function triggerJobHistoryBackfill(shopId: number) {
  try {
    await sql`
      INSERT INTO tekmetric_backfill_progress (shop_id, queued_at, completed, logic_version)
      VALUES (${shopId}, ${new Date()}, false, 2)
      ON CONFLICT (shop_id) DO UPDATE SET 
        queued_at = ${new Date()},
        completed = false,
        logic_version = 2
    `;
    
    const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1`;
    const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
    const updatedSettings = { ...existingSettings, tekmetricBackfillComplete: false };
    
    await sql`
      UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb
      WHERE shop_id = ${String(shopId)}
    `;
    
    console.log(`[Tekmetric Settings] Queued job history backfill for shop ${shopId}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Tekmetric Settings] Failed to queue backfill for shop ${shopId}:`, message);
  }
}

async function getUserShopId(): Promise<string | null> {
  const store = await cookies();
  const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
  if (!sid) return null;

  const now = new Date();
  const sessResult = await sql`
    SELECT * FROM sessions WHERE token = ${sid} AND expires_at > ${now} LIMIT 1
  `;
  const sess = sessResult[0];
  if (!sess) return null;

  const userResult = await sql`SELECT shop_id FROM users WHERE id = ${sess.user_id} LIMIT 1`;
  const user = userResult[0];
  return user?.shop_id ? String(user.shop_id) : null;
}

export async function GET() {
  try {
    const shopId = await getUserShopId();
    if (!shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopResult = await sql`
      SELECT tekmetric_config FROM shops WHERE shop_id = ${shopId} LIMIT 1
    `;
    const shop = shopResult[0];
    const tekmetricConfig = shop?.tekmetric_config as Record<string, unknown> | null;
    
    if (!tekmetricConfig?.shopId) {
      return NextResponse.json({
        configured: false,
        shopId: null,
        shopName: null,
      });
    }

    return NextResponse.json({
      configured: true,
      shopId: tekmetricConfig.shopId,
      shopName: tekmetricConfig.shopName,
      lastSync: tekmetricConfig.lastSync,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error fetching Tekmetric settings:", error);
    return NextResponse.json(
      { error: message || "Failed to fetch settings" },
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

    const shopResult = await sql`SELECT tekmetric_config, settings FROM shops WHERE shop_id = ${userShopId} LIMIT 1`;
    const existingTekmetricConfig = (shopResult[0]?.tekmetric_config as Record<string, unknown>) || {};
    const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
    
    const updatedTekmetricConfig = {
      ...existingTekmetricConfig,
      shopId: tekmetricShopId,
      shopName: validation.shop?.name,
      connectedAt: new Date().toISOString(),
    };
    
    const updatedSettings = {
      ...existingSettings,
      integrationProvider: "tekmetric",
    };

    await sql`
      UPDATE shops 
      SET tekmetric_config = ${JSON.stringify(updatedTekmetricConfig)}::jsonb,
          settings = ${JSON.stringify(updatedSettings)}::jsonb,
          updated_at = ${new Date()}
      WHERE shop_id = ${userShopId}
    `;

    let syncResult: { success: boolean; synced: number; error?: string } = { success: false, synced: 0 };
    try {
      syncResult = await syncSingleShop(userShopId, tekmetricShopId);
    } catch (syncErr: unknown) {
      const message = syncErr instanceof Error ? syncErr.message : "Unknown error";
      console.error("[Tekmetric Settings] Initial sync failed:", message);
      syncResult.error = message;
    }

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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error saving Tekmetric settings:", error);
    return NextResponse.json(
      { error: message || "Failed to save settings" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    const userShopId = await getUserShopId();
    if (!userShopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await sql`
      UPDATE shops SET tekmetric_config = NULL, updated_at = ${new Date()}
      WHERE shop_id = ${userShopId}
    `;

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Error disconnecting Tekmetric:", error);
    return NextResponse.json(
      { error: message || "Failed to disconnect" },
      { status: 500 }
    );
  }
}
