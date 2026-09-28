import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { resolveProtractorConfig } from "@/lib/integrations/protractor";
import { ensureProtractorWebhookSubscription } from "@/lib/integrations/protractor/webhook-subscribe";
import { validateCredentials, validationFailure } from "./validation";
import { saveProtractorConnection, ConnectionConflict, initialSyncStatus, storedBinding } from "@/lib/integrations/protractor/onboarding";
import {
  DEFAULT_PART_COST_RATIO, MIN_PART_COST_RATIO, MAX_PART_COST_RATIO, isValidPartCostRatio,
} from "@/lib/integrations/protractor/part-cost";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const shopId = Number(session.shopId);
    const config = await resolveProtractorConfig(shopId);
    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });
    let webhookToken = shop?.protractorWebhookToken;
    if (config.configured && !webhookToken) {
      webhookToken = crypto.randomBytes(16).toString("hex");
      await db.collection("shops").updateOne({ shopId }, { $set: { protractorWebhookToken: webhookToken } });
    }
    return NextResponse.json({
      configured: config.configured,
      connectionId: config.connectionId || null,
      connectionIdShort: config.connectionId ? `${config.connectionId.slice(0, 8)}...` : null,
      apiKey: config.apiKey || null,
      apiKeyShort: config.apiKey ? `${config.apiKey.slice(0, 8)}...` : null,
      hasApiKey: Boolean(config.apiKey),
      updateWorkOrderPackage: shop?.protractor?.updateWorkOrderPackage ?? false,
      updateWorkOrderLine: shop?.protractor?.updateWorkOrderLine ?? false,
      webhookToken: config.configured ? webhookToken : null,
      ...await initialSyncStatus(shop, shopId),
      partCostEstimateRatio: isValidPartCostRatio(shop?.partCostEstimateRatio) ? shop.partCostEstimateRatio : null,
      partCostEstimateRatioDefault: DEFAULT_PART_COST_RATIO,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const shopId = Number(session.shopId);
    if (!Number.isSafeInteger(shopId) || shopId <= 0) {
      return NextResponse.json({ error: "Invalid shop" }, { status: 403 });
    }
    const { connectionId, apiKey } = await req.json();
    if (typeof connectionId !== "string" || !connectionId.trim() ||
        typeof apiKey !== "string" || !apiKey.trim()) {
      return NextResponse.json({ error: "Connection ID and API Key are required" }, { status: 400 });
    }
    const cleanConnectionId = connectionId.trim().toLowerCase();
    const cleanApiKey = apiKey.trim().toLowerCase();
    const result = await validateCredentials(shopId, cleanConnectionId, cleanApiKey);
    if (!result.ok) {
      const failure = validationFailure(result);
      return NextResponse.json(failure.body, { status: failure.status });
    }
    const db = await getDb();
    const state = await saveProtractorConnection(db, shopId, cleanConnectionId, cleanApiKey, result.locations);
    // This is bookkeeping, NOT evidence that Protractor delivered a callback.
    // Await it rather than detaching request-lifetime work.
    try {
      await ensureProtractorWebhookSubscription({ shopId, db });
    } catch {
      console.warn(JSON.stringify({
        event: "protractor_onboarding_webhook_bookkeeping_unavailable",
        shopId,
      }));
    }
    return NextResponse.json({
      ok: true,
      message: state.initialSyncState === "complete"
        ? "Protractor connected. Historical sync is complete."
        : state.initialSyncState === "failed"
          ? "Protractor connected. The previous historical sync error is retained until a worker retries."
          : "Protractor connected. Historical sync is queued for an approved background worker.",
      locations: result.locations,
      jobHistoryBackfill: state.initialSyncState === "complete" ? "complete" :
        state.initialSyncState === "failed" ? "failed" : "queued",
      ...state,
    });
  } catch (err: any) {
    if (err instanceof ConnectionConflict) {
      return NextResponse.json({ error: err.message, code: "PROTRACTOR_CONNECTION_CONFLICT" }, { status: 409 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const role = (session as any).role;
    if (role !== "admin" && role !== "owner" && role !== "platform_admin") {
      return NextResponse.json({ error: "Not authorized" }, { status: 403 });
    }
    const shopId = Number(session.shopId);
    const body = await req.json();
    if (!("partCostEstimateRatio" in body)) {
      return NextResponse.json({ error: "partCostEstimateRatio is required" }, { status: 400 });
    }
    const raw = body.partCostEstimateRatio;
    const db = await getDb();
    if (raw === null || raw === "" || raw === undefined) {
      await db.collection("shops").updateOne({ shopId }, {
        $unset: { partCostEstimateRatio: "" }, $set: { updatedAt: new Date() },
      });
      return NextResponse.json({ ok: true, partCostEstimateRatio: null });
    }
    const ratio = Number(raw);
    if (!isValidPartCostRatio(ratio)) {
      return NextResponse.json({
        error: `Cost ratio must be a number between ${MIN_PART_COST_RATIO} and ${MAX_PART_COST_RATIO} (e.g. 0.6 = cost is 60% of retail)`,
      }, { status: 400 });
    }
    await db.collection("shops").updateOne({ shopId }, { $set: { partCostEstimateRatio: ratio, updatedAt: new Date() } });
    return NextResponse.json({ ok: true, partCostEstimateRatio: ratio });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = await getDb();
    // Retain the binding and cached data. Rebinding data to another connection
    // requires an operator-controlled migration, not destructive web cleanup.
    const shopId = Number(session.shopId);
    const shop = await db.collection("shops").findOne({ shopId });
    const generation = storedBinding(shop);
    const changed = await db.collection("shops").updateOne({
      shopId,
      protractorConnectionId: shop?.protractorConnectionId ?? { $exists: false },
      protractorApiKey: shop?.protractorApiKey ?? { $exists: false },
      "protractor.connectionGeneration": shop?.protractor?.connectionGeneration ?? { $exists: false },
      "protractor.checkpointWriteToken": { $exists: false },
    }, {
      $unset: { protractorConnectionId: "", protractorApiKey: "", "protractor.connectionId": "", "protractor.apiKey": "" },
      $set: {
        "protractor.configured": false,
        "protractor.disconnectedAt": new Date(),
        "protractor.syncRevision": crypto.randomUUID(),
        ...(generation ? { "protractor.connectionGeneration": generation } : {}),
        updatedAt: new Date(),
      },
    });
    if (changed.matchedCount !== 1) {
      return NextResponse.json({ error: "Connection changed; reload and retry.", code: "PROTRACTOR_CONNECTION_CONFLICT" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, message: "Protractor disconnected" });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}