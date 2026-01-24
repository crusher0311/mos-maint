import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { testConnection, resolveProtractorConfig } from "@/lib/integrations/protractor";
import { runProtractorBackfill } from "@/lib/integrations/protractor-backfill";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const config = await resolveProtractorConfig(shopId);

    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { protractor: 1, protractorWebhookToken: 1 } }
    );

    let webhookToken = shop?.protractorWebhookToken;
    if (config.configured && !webhookToken) {
      webhookToken = crypto.randomBytes(16).toString("hex");
      await db.collection("shops").updateOne(
        { shopId },
        { $set: { protractorWebhookToken: webhookToken } }
      );
    }

    return NextResponse.json({
      configured: config.configured,
      connectionId: config.connectionId ? `${config.connectionId.slice(0, 8)}...` : null,
      hasApiKey: Boolean(config.apiKey),
      updateWorkOrderPackage: shop?.protractor?.updateWorkOrderPackage ?? false,
      updateWorkOrderLine: shop?.protractor?.updateWorkOrderLine ?? false,
      webhookToken: config.configured ? webhookToken : null,
    });
  } catch (err: any) {
    console.error("[Protractor Settings] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
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

    const db = await getDb();
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
    
    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          protractorConnectionId: cleanConnectionId,
          protractorApiKey: cleanApiKey,
          protractorWebhookToken: webhookToken,
          "protractor.configured": true,
          "protractor.configuredAt": new Date(),
          "protractor.locations": testResult.locations,
          "protractor.updateWorkOrderPackage": true,
          "protractor.updateWorkOrderLine": true,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    await db.collection("protractor_canned_jobs").deleteOne({ shopId });
    await db.collection("protractor_vehicles").deleteMany({ shopId });
    await db.collection("protractor_work_orders").deleteMany({ shopId });
    await db.collection("protractor_deferred_work").deleteMany({ shopId });

    // Run job history backfill inline (fire-and-forget, runs in background)
    runProtractorBackfill(shopId).then(result => {
      console.log(`[Protractor Settings] Backfill completed for shop ${shopId}:`, result);
    }).catch(err => {
      console.error(`[Protractor Settings] Backfill failed for shop ${shopId}:`, err.message);
    });

    return NextResponse.json({
      ok: true,
      message: "Protractor connected successfully. Historical data sync started.",
      locations: testResult.locations,
      jobHistoryBackfill: "started"
    });
  } catch (err: any) {
    console.error("[Protractor Settings] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const db = await getDb();

    await db.collection("shops").updateOne(
      { shopId },
      {
        $unset: {
          protractorConnectionId: "",
          protractorApiKey: "",
          "protractor.configured": "",
        },
        $set: {
          "protractor.disconnectedAt": new Date(),
          updatedAt: new Date(),
        },
      }
    );

    await db.collection("protractor_canned_jobs").deleteOne({ shopId });
    await db.collection("protractor_vehicles").deleteMany({ shopId });
    await db.collection("protractor_work_orders").deleteMany({ shopId });
    await db.collection("protractor_deferred_work").deleteMany({ shopId });

    return NextResponse.json({ ok: true, message: "Protractor disconnected" });
  } catch (err: any) {
    console.error("[Protractor Settings] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
