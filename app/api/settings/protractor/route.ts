import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { testConnection, resolveProtractorConfig } from "@/lib/integrations/protractor";
import { runProtractorBackfill } from "@/lib/integrations/protractor/sync";
import { prewarmProtractorJobsCacheForOnboarding } from "@/lib/integrations/protractor/jobs-prewarm";
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

    // Watchdog: mirrors the Tekmetric GET (task #437 / 2026-05-18 fix).
    // If the in-process initial-sync promise was lost to a Render restart,
    // the shops doc would be stuck at "running" forever. After ~15 minutes
    // (well past the worst case for prewarm + first backfill batch) treat
    // it as failed so the UI stops spinning. The nightly cron will fill
    // in the data regardless. Read-only — just reported as failed until
    // the next successful sync flips it back.
    let initialSyncState: "running" | "complete" | "failed" =
      shop?.protractor?.initialSyncState ?? "complete";
    let initialSyncError: string | null = shop?.protractor?.initialSyncError ?? null;
    if (initialSyncState === "running") {
      const startedAt = shop?.protractor?.initialSyncStartedAt
        ? new Date(shop.protractor.initialSyncStartedAt).getTime()
        : 0;
      if (startedAt && Date.now() - startedAt > 15 * 60 * 1000) {
        initialSyncState = "failed";
        initialSyncError =
          initialSyncError || "Initial sync didn't finish in 15 minutes — nightly sync will catch up.";
      }
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
      initialSyncState,
      initialSyncVehicles: shop?.protractor?.initialSyncVehicles ?? null,
      initialSyncError,
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

    // Perf: cap the credential-validation round-trip at 5s. Protractor's
    // `/Location/` endpoint is the synchronous "is this real" check the
    // user is staring at the spinner for — if it hangs, surface a
    // friendly retry message instead of leaving the UI spinning
    // indefinitely. The timing log lets us see real numbers in
    // BetterStack to decide whether to tune the cap further.
    const CONNECT_TIMEOUT_MS = 5000;
    const tcStart = Date.now();
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<{ ok: false; error: string; timedOut: true }>(
      (resolve) => {
        timeoutHandle = setTimeout(
          () =>
            resolve({
              ok: false,
              error: `Protractor did not respond within ${CONNECT_TIMEOUT_MS}ms`,
              timedOut: true,
            }),
          CONNECT_TIMEOUT_MS
        );
      }
    );
    // NOTE: when testConnection wins we clear the timer so the event
    // loop doesn't hold an unnecessary handle. The losing
    // testConnection request itself is not aborted (would require
    // threading an AbortSignal through protractorFetch — separate
    // refactor); on a timeout it continues in the background and its
    // result is discarded.
    const testResult = await Promise.race([
      testConnection(cleanConnectionId, cleanApiKey).finally(() => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
      }),
      timeoutPromise,
    ]);
    const tcMs = Date.now() - tcStart;
    console.log(
      `[Protractor Settings] testConnection for shop ${shopId} took ${tcMs}ms ok=${testResult.ok}${
        (testResult as any).timedOut ? " (TIMEOUT)" : ""
      }`
    );

    if (!testResult.ok) {
      const friendly = (testResult as any).timedOut
        ? "Protractor's API is slow or unreachable right now. Please try again in a moment."
        : `Connection test failed: ${testResult.error}`;
      return NextResponse.json({ error: friendly }, { status: 400 });
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
          // Initial-sync state mirrors the Tekmetric Connect parity fix
          // (task #437): the POST returns the instant the shops doc is
          // written and creds are validated; the prewarm + first
          // backfill batch run in the background and flip this to
          // "complete"/"failed" so the UI can surface progress without
          // a manual refresh. The GET watchdog cleans up if the
          // in-process promise is lost to a Render restart.
          "protractor.initialSyncState": "running",
          "protractor.initialSyncStartedAt": new Date(),
          protractorBackfillComplete: false,
          updatedAt: new Date(),
          integrationProvider: "protractor",
        },
        $unset: {
          protractorBackfillCompletedAt: "",
          "protractor.initialSyncError": "",
          "protractor.initialSyncFinishedAt": "",
          "protractor.initialSyncVehicles": "",
        },
        $setOnInsert: {
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Connect-confirm pattern: once Protractor has validated the creds
    // and the shops doc is written, the user's spinner has earned the
    // right to stop. Everything below — wiping any prior shop data,
    // pre-warming the invoice cache, kicking the 5-year backfill — is
    // moved into a single fire-and-forget block so the POST returns
    // immediately. For a brand-new shop the deletes are near-instant;
    // for a reconnect they can churn (cached_plans / work_orders),
    // which used to add real seconds to the spinner the user was
    // staring at. The async block awaits internally so the cleanup
    // finishes before the backfill fans out per-invoice fetches.
    (async () => {
      const cleanupStart = Date.now();
      let initialSyncError: string | null = null;
      try {
        await Promise.all([
          db.collection("protractor_canned_jobs").deleteOne({ shopId }),
          db.collection("protractor_vehicles").deleteMany({ shopId }),
          db.collection("protractor_work_orders").deleteMany({ shopId }),
          db.collection("protractor_deferred_work").deleteMany({ shopId }),
          db.collection("backfill_progress").deleteOne({ shopId }),
          db.collection("cached_plans").deleteMany({ shopId }),
        ]);
        console.log(
          `[Protractor Settings] Stale-data cleanup for shop ${shopId} took ${Date.now() - cleanupStart}ms`
        );
      } catch (cleanupErr: any) {
        console.error(
          `[Protractor Settings] Stale-data cleanup failed for shop ${shopId}: ${cleanupErr?.message || cleanupErr}`
        );
      }
      try {
        await prewarmProtractorJobsCacheForOnboarding(shopId);
      } catch (warmErr: any) {
        console.warn(
          `[Protractor Settings] Invoice cache prewarm failed (non-fatal) for shop ${shopId}: ${warmErr?.message || warmErr}`
        );
      }
      try {
        // singlePass: don't wait for the full 5-year backfill chain to
        // collapse before flipping the UI indicator. The first batch is
        // enough to call the "initial sync" done; the cron picks up the
        // rest. Mirrors how Tekmetric's initial-sync indicator only
        // covers the active-RO sync, not the multi-day history backfill.
        const result = await runProtractorBackfill(shopId, { singlePass: true });
        console.log(`[Protractor Settings] Backfill initial batch for shop ${shopId}:`, result);
        if (result.error) initialSyncError = result.error;
      } catch (err: any) {
        console.error(`[Protractor Settings] Backfill failed for shop ${shopId}:`, err.message);
        initialSyncError = err?.message || "unknown";
      }

      // Count vehicles fetched during onboarding (prewarm + first
      // backfill batch populate `protractor_service_items`). Surfaces
      // the parity "imported N vehicles" line in the UI.
      let initialSyncVehicles = 0;
      try {
        initialSyncVehicles = await db
          .collection("protractor_service_items")
          .countDocuments({ shopId });
      } catch {}

      await db.collection("shops").updateOne(
        { shopId },
        {
          $set: {
            "protractor.initialSyncState": initialSyncError ? "failed" : "complete",
            "protractor.initialSyncFinishedAt": new Date(),
            "protractor.initialSyncVehicles": initialSyncVehicles,
            ...(initialSyncError ? { "protractor.initialSyncError": initialSyncError } : {}),
          },
          ...(initialSyncError ? {} : { $unset: { "protractor.initialSyncError": "" } }),
        }
      ).catch(() => {});
    })();

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
