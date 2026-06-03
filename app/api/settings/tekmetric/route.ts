import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { validateShopAccess } from "@/lib/integrations/tekmetric";
import { syncSingleShop } from "@/lib/integrations/tekmetric/sync";
import { prewarmTekmetricJobsCacheForOnboarding } from "@/lib/integrations/tekmetric/jobs-prewarm";
import { subscribeShopToTekmetricWebhooks } from "@/lib/integrations/tekmetric/webhook-subscribe";

// Tekmetric Connect (POST) used to block the response on the full
// `syncSingleShop` call — for a busy shop that's up to 1000 active ROs
// plus per-RO vehicle/customer lookups (~4-5 minutes against the shared
// rate limiter). The route had no maxDuration export, so Render killed
// it at the platform default, the browser never saw the response, and
// the UI sat on a spinner (Pierce's 10-15 minute hang, 2026-05-18).
// Sync is now fire-and-forget like the job-history backfill below, the
// shops doc is written before we return, and the UI polls GET to flip
// itself to the "Connected" state without a manual refresh.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function triggerJobHistoryBackfill(shopId: number, tekmetricShopId: number) {
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

    // Pre-warm `tekmetric_jobs_cache` for the most recent terminal ROs
    // before we kick the cron. The first backfill chunk is the most
    // recent ~90 days; warming that window means the cron's very first
    // chunk hits Mongo for `/jobs` instead of paying the full per-RO API
    // cost. See lib/tekmetric-jobs-prewarm.ts and task #59. We await
    // here (the caller already invokes us fire-and-forget) so the cron
    // POST below races against a warm cache, not an empty one.
    try {
      await prewarmTekmetricJobsCacheForOnboarding(shopId, tekmetricShopId);
    } catch (warmErr: any) {
      console.warn(
        `[Tekmetric Settings] Jobs cache prewarm failed (non-fatal) for shop ${shopId}: ${warmErr?.message || warmErr}`
      );
    }

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
        console.log(`[Tekmetric Settings] Backfill auto-trigger note: ${err.message}`);
      });
      console.log(`[Tekmetric Settings] Auto-triggered full backfill for shop ${shopId}`);
    } catch (e) {
      // fire-and-forget, cron worker will pick it up regardless
    }
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

    // Watchdog: if the in-process sync promise was lost to a Render
    // restart, the shops doc would be stuck at "running" forever. After
    // ~15 minutes (well past the 4-5 minute worst case) treat it as
    // failed so the UI stops spinning. The nightly cron sync will fill
    // in the data regardless. Doesn't write — just reported as failed
    // until the next successful sync flips it back.
    let initialSyncState: "running" | "complete" | "failed" =
      shop.tekmetric.initialSyncState ?? "complete";
    let initialSyncError: string | null = shop.tekmetric.initialSyncError ?? null;
    if (initialSyncState === "running") {
      const startedAt = shop.tekmetric.initialSyncStartedAt
        ? new Date(shop.tekmetric.initialSyncStartedAt).getTime()
        : 0;
      if (startedAt && Date.now() - startedAt > 15 * 60 * 1000) {
        initialSyncState = "failed";
        initialSyncError =
          initialSyncError || "Initial sync didn't finish in 15 minutes — nightly sync will catch up.";
      }
    }

    return NextResponse.json({
      configured: true,
      shopId: shop.tekmetric.shopId,
      shopName: shop.tekmetric.shopName,
      lastSync: shop.tekmetric.lastSync,
      // Surface async initial-sync state so the UI can show
      // "Connected — syncing first vehicles…" while it's still running
      // and switch to a steady state once it's done. Older shops that
      // pre-date this field default to "complete" so we don't show a
      // spinner forever for already-connected accounts.
      initialSyncState,
      initialSyncVehicles: shop.tekmetric.initialSyncVehicles ?? null,
      initialSyncError,
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
      // tekmetricRequest throws messages shaped
      //   "Tekmetric API error <code> on <endpoint>: <reason>"
      // (see lib/integrations/tekmetric/client.ts). Parse the status code
      // explicitly so we don't misclassify unrelated errors as auth issues.
      // 401/403 → shop hasn't authorized the MOS OAuth client.
      // 404     → ambiguous: shop ID truly doesn't exist OR it exists but
      //           we're not granted access; tell the user both.
      const raw = validation.error || "";
      const statusMatch = raw.match(/Tekmetric API error (\d{3})/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      let message = raw || "Unable to access shop";
      if (status === 401 || status === 403) {
        message = `Tekmetric won't let MOS read shop ${tekmetricShopId}. Inside Tekmetric, go to Settings → Integrations and authorize "MOS Maintenance" for this shop, then try Connect again.`;
      } else if (status === 404) {
        message = `Tekmetric returned "not found" for shop ${tekmetricShopId}. Double-check the Shop ID. If it's correct, the shop may not have authorized MOS yet — open Tekmetric → Settings → Integrations and authorize "MOS Maintenance".`;
      }
      return NextResponse.json({ error: message }, { status: 400 });
    }

    const db = await getDb();

    // Write the shops doc FIRST. The GET handler keys "configured" off
    // this field, so once this completes the UI's poll will flip to
    // the Connected/webhook-URL block even if the initial sync below
    // is still running.
    await db.collection("shops").updateOne(
      { shopId: { $in: [userShopId, Number(userShopId)] } },
      {
        $set: {
          "tekmetric.shopId": tekmetricShopId,
          "tekmetric.shopName": validation.shop?.name,
          "tekmetric.connectedAt": new Date(),
          "tekmetric.initialSyncState": "running",
          "tekmetric.initialSyncStartedAt": new Date(),
          integrationProvider: "tekmetric",
        },
        $unset: { "tekmetric.initialSyncError": "" },
      },
      { upsert: true }
    );

    // Fire-and-forget the initial active-RO sync. Was previously awaited,
    // which made Connect block for minutes against the shared rate limiter
    // and hit the Render route timeout (see header comment). The cron
    // sync + the job-history backfill kicked off below will catch up
    // anything missed if this promise loses to a process restart.
    syncSingleShop(userShopId, tekmetricShopId)
      .then(async (result) => {
        await db.collection("shops").updateOne(
          { shopId: { $in: [userShopId, Number(userShopId)] } },
          {
            $set: {
              "tekmetric.initialSyncState": result.success ? "complete" : "failed",
              "tekmetric.initialSyncFinishedAt": new Date(),
              "tekmetric.initialSyncVehicles": result.synced ?? 0,
              ...(result.error ? { "tekmetric.initialSyncError": result.error } : {}),
            },
          }
        );
      })
      .catch(async (err: any) => {
        console.error(`[Tekmetric Settings] Initial sync threw for shop ${userShopId}:`, err?.message);
        await db.collection("shops").updateOne(
          { shopId: { $in: [userShopId, Number(userShopId)] } },
          {
            $set: {
              "tekmetric.initialSyncState": "failed",
              "tekmetric.initialSyncFinishedAt": new Date(),
              "tekmetric.initialSyncError": err?.message || "unknown",
            },
          }
        ).catch(() => {});
      });

    // Queue the 5-year job history backfill (runs via cron). The trigger
    // also pre-warms `tekmetric_jobs_cache` for recent terminal ROs so
    // the first backfill chunk lands at cache-hit speed (task #59).
    triggerJobHistoryBackfill(Number(userShopId), tekmetricShopId).catch(() => {});

    // Auto-subscribe this shop to Tekmetric webhooks so freshness doesn't
    // depend on someone manually wiring the callback URL in the Tekmetric
    // portal (task #569). Fire-and-forget — onboarding must never block or
    // fail on this. The helper is gated default-OFF behind
    // TEKMETRIC_WEBHOOK_AUTO_SUBSCRIBE and records every outcome to
    // `tekmetric_webhook_subscriptions` for the webhook-health view; when
    // disabled it's a safe no-op that returns early.
    subscribeShopToTekmetricWebhooks({
      tekmetricShopId,
      mosShopId: userShopId,
    })
      .then((result) => {
        if (!result.ok && result.reason !== "auto_subscribe_disabled") {
          console.warn(
            `[Tekmetric Settings] Webhook auto-subscribe for shop ${tekmetricShopId} did not succeed: ${result.reason}`,
          );
        }
      })
      .catch((err: any) =>
        console.warn(
          `[Tekmetric Settings] Webhook auto-subscribe threw for shop ${tekmetricShopId}:`,
          err?.message,
        ),
      );

    return NextResponse.json({
      success: true,
      shopId: tekmetricShopId,
      shopName: validation.shop?.name,
      initialSync: { state: "running" },
      jobHistoryBackfill: "queued",
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
