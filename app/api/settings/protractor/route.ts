import { NextResponse, NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { testConnection, resolveProtractorConfig } from "@/lib/integrations/protractor";
import { runProtractorBackfill } from "@/lib/integrations/protractor-backfill";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const config = await resolveProtractorConfig(shopId);

    const shopResult = await sql`
      SELECT protractor_config, settings FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;
    const shop = shopResult[0];
    const protractorConfig = shop?.protractor_config as Record<string, unknown> | null;
    const settings = shop?.settings as Record<string, unknown> | null;

    let webhookToken = settings?.protractorWebhookToken as string | undefined;
    if (config.configured && !webhookToken) {
      webhookToken = crypto.randomBytes(16).toString("hex");
      const updatedSettings = { ...settings, protractorWebhookToken: webhookToken };
      await sql`
        UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb
        WHERE shop_id = ${String(shopId)}
      `;
    }

    return NextResponse.json({
      configured: config.configured,
      connectionId: config.connectionId ? `${config.connectionId.slice(0, 8)}...` : null,
      hasApiKey: Boolean(config.apiKey),
      updateWorkOrderPackage: (protractorConfig?.updateWorkOrderPackage as boolean) ?? false,
      updateWorkOrderLine: (protractorConfig?.updateWorkOrderLine as boolean) ?? false,
      webhookToken: config.configured ? webhookToken : null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Protractor Settings] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const body = await req.json();
    const { connectionId, apiKey } = body;

    if (!connectionId || !apiKey) {
      return NextResponse.json(
        { error: "Connection ID and API Key are required" },
        { status: 400 }
      );
    }

    const cleanConnectionId = connectionId.trim().toLowerCase();
    const cleanApiKey = apiKey.trim().toLowerCase();

    const testResult = await testConnection(cleanConnectionId, cleanApiKey);
    if (!testResult.ok) {
      return NextResponse.json(
        { error: `Connection test failed: ${testResult.error}` },
        { status: 400 }
      );
    }

    const webhookToken = crypto.randomBytes(16).toString("hex");
    const now = new Date();
    
    const shopResult = await sql`SELECT settings, protractor_config FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1`;
    const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
    
    const updatedProtractorConfig = {
      configured: true,
      configuredAt: now.toISOString(),
      locations: testResult.locations,
      updateWorkOrderPackage: true,
      updateWorkOrderLine: true,
      connectionId: cleanConnectionId,
      apiKey: cleanApiKey,
    };
    
    const updatedSettings = {
      ...existingSettings,
      protractorWebhookToken: webhookToken,
      protractorBackfillComplete: false,
      integrationProvider: "protractor",
    };

    await sql`
      UPDATE shops 
      SET protractor_config = ${JSON.stringify(updatedProtractorConfig)}::jsonb,
          settings = ${JSON.stringify(updatedSettings)}::jsonb,
          updated_at = ${now}
      WHERE shop_id = ${String(shopId)}
    `;

    await Promise.all([
      sql`DELETE FROM protractor_canned_jobs WHERE shop_id = ${String(shopId)}`,
      sql`DELETE FROM protractor_vehicles WHERE shop_id = ${String(shopId)}`,
      sql`DELETE FROM protractor_work_orders WHERE shop_id = ${String(shopId)}`,
      sql`DELETE FROM backfill_progress WHERE shop_id = ${String(shopId)}`,
      sql`DELETE FROM cached_plans WHERE shop_id = ${String(shopId)}`,
    ]);

    runProtractorBackfill(shopId).then(result => {
      console.log(`[Protractor Settings] Backfill completed for shop ${shopId}:`, result);
    }).catch(err => {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[Protractor Settings] Backfill failed for shop ${shopId}:`, message);
    });

    return NextResponse.json({
      ok: true,
      message: "Protractor connected successfully. Historical data sync started.",
      locations: testResult.locations,
      jobHistoryBackfill: "started"
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Protractor Settings] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = String(session.shopId);
    const now = new Date();

    const shopResult = await sql`SELECT protractor_config FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const existingConfig = (shopResult[0]?.protractor_config as Record<string, unknown>) || {};
    
    const updatedConfig = {
      ...existingConfig,
      configured: false,
      disconnectedAt: now.toISOString(),
      connectionId: null,
      apiKey: null,
    };

    await sql`
      UPDATE shops 
      SET protractor_config = ${JSON.stringify(updatedConfig)}::jsonb, updated_at = ${now}
      WHERE shop_id = ${shopId}
    `;

    await Promise.all([
      sql`DELETE FROM protractor_canned_jobs WHERE shop_id = ${shopId}`,
      sql`DELETE FROM protractor_vehicles WHERE shop_id = ${shopId}`,
      sql`DELETE FROM protractor_work_orders WHERE shop_id = ${shopId}`,
    ]);

    return NextResponse.json({ ok: true, message: "Protractor disconnected" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Protractor Settings] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
