import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { validateApiKey, discoverIdsFromKey } from "@/lib/integrations/shopmonkey/auth";
import { subscribeShopToShopmonkeyWebhooks } from "@/lib/integrations/shopmonkey/webhook-subscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Shopmonkey shop settings — mirror of /api/settings/tekmetric, adapted for
 * Shopmonkey's per-shop API-key auth (no global OAuth client). POST validates
 * the key against Shopmonkey's status endpoint and persists it on the shop doc.
 *
 * PROD-SAFE: connecting a shop does NOT auto-trigger a history backfill (unlike
 * Tekmetric). The backfill cron is independently gated behind
 * SHOPMONKEY_BACKFILL_ENABLED, so onboarding only writes config + (optionally)
 * subscribes webhooks. No existing shop is migrated.
 */

async function getUserShopId(): Promise<string | null> {
  // Resolve the ACTIVE session shop (the shop switcher updates
  // session.shopId), so a platform admin viewing another shop sees THAT
  // shop's connection state. Mirrors the carfax/autoflow/protractor/
  // integrations routes and the Data Status panel.
  const session = await getSession();
  return session?.shopId ? String(session.shopId) : null;
}

export async function GET() {
  try {
    const shopId = await getUserShopId();
    if (!shopId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId: { $in: [shopId, Number(shopId)] } });

    if (!shop?.shopmonkey?.apiKey) {
      return NextResponse.json({ configured: false, locationId: null, companyId: null });
    }

    return NextResponse.json({
      configured: true,
      // Never echo the API key back to the client — only confirm presence.
      hasApiKey: true,
      locationId: shop.shopmonkey.locationId ?? null,
      companyId: shop.shopmonkey.companyId ?? null,
      connectedAt: shop.shopmonkey.connectedAt ?? null,
      lastSyncAt: shop.shopmonkey.lastSyncAt ?? null,
    });
  } catch (error: any) {
    console.error("Error fetching Shopmonkey settings:", error);
    return NextResponse.json({ error: error.message || "Failed to fetch settings" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const userShopId = await getUserShopId();
    if (!userShopId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json();
    const apiKey: string | undefined = body?.apiKey?.trim();
    const locationId: string | undefined = body?.locationId?.trim() || undefined;
    const companyId: string | undefined = body?.companyId?.trim() || undefined;

    if (!apiKey) {
      return NextResponse.json({ error: "API key is required" }, { status: 400 });
    }

    const validation = await validateApiKey(apiKey);
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error || "Shopmonkey rejected this API key. Double-check it and try again." },
        { status: 400 },
      );
    }

    // Self-onboard the shop's Shopmonkey ids: when the operator didn't paste a
    // company/location id, derive them from the validated key (each key reports
    // only its own location's id/companyId). This is what lets the extension
    // resolve the shop by the on-page Shopmonkey id without manual entry. A
    // forbidden/transient key returns nulls and we just store what we have.
    let resolvedLocationId = locationId ?? null;
    let resolvedCompanyId = companyId ?? null;
    if (!resolvedLocationId || !resolvedCompanyId) {
      const discovered = await discoverIdsFromKey(apiKey);
      resolvedLocationId = resolvedLocationId ?? discovered.locationId;
      resolvedCompanyId = resolvedCompanyId ?? discovered.companyId;
    }

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId: { $in: [userShopId, Number(userShopId)] } },
      {
        $set: {
          "shopmonkey.apiKey": apiKey,
          "shopmonkey.locationId": resolvedLocationId,
          "shopmonkey.companyId": resolvedCompanyId,
          "shopmonkey.connectedAt": new Date(),
          integrationProvider: "shopmonkey",
        },
      },
      { upsert: true },
    );

    // Auto-subscribe webhooks (gated default-OFF behind
    // SHOPMONKEY_WEBHOOK_AUTO_SUBSCRIBE). Fire-and-forget — onboarding must
    // never block or fail on this; when disabled it's a safe no-op.
    subscribeShopToShopmonkeyWebhooks({
      mosShopId: Number(userShopId),
      locationId: resolvedLocationId ?? undefined,
      companyId: resolvedCompanyId ?? undefined,
    })
      .then((result) => {
        if (!result.ok && result.reason !== "auto_subscribe_disabled") {
          console.warn(`[Shopmonkey Settings] Webhook auto-subscribe for shop ${userShopId} did not succeed: ${result.reason}`);
        }
      })
      .catch((err: any) =>
        console.warn(`[Shopmonkey Settings] Webhook auto-subscribe threw for shop ${userShopId}:`, err?.message),
      );

    return NextResponse.json({
      success: true,
      configured: true,
      locationId: resolvedLocationId,
      companyId: resolvedCompanyId,
    });
  } catch (error: any) {
    console.error("Error saving Shopmonkey settings:", error);
    return NextResponse.json({ error: error.message || "Failed to save settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const userShopId = await getUserShopId();
    if (!userShopId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId: { $in: [userShopId, Number(userShopId)] } },
      { $unset: { shopmonkey: "" } },
    );

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Error disconnecting Shopmonkey:", error);
    return NextResponse.json({ error: error.message || "Failed to disconnect" }, { status: 500 });
  }
}
