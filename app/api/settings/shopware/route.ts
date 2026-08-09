import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getDb } from '@/lib/mongo';
import { testConnection, getShop, getShops, getPartnerAuthorizations, isConfigured } from '@/lib/integrations/shopware/client';
import {
  isShopWareNotFound,
  suggestTenantId,
  buildTenantConnectError,
} from '@/lib/integrations/shopware/connect-errors';
import { prewarmShopWareJobsCacheForOnboarding } from '@/lib/shopware-jobs-prewarm';

async function triggerShopWareBackfillCron(shopId: number): Promise<void> {
  try {
    const baseUrl = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:5000';

    fetch(`${baseUrl}/api/cron/shopware-backfill?shopId=${shopId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET || ''}`,
      },
    }).catch((err) => {
      console.log(`[Shop-Ware Settings] Backfill auto-trigger note: ${err.message}`);
    });
    console.log(`[Shop-Ware Settings] Auto-triggered backfill for shop ${shopId}`);
  } catch {
    // fire-and-forget; nightly cron will pick the shop up regardless
  }
}

async function getUserShopId(): Promise<string | null> {
  // Resolve the ACTIVE session shop (the shop switcher updates
  // session.shopId), so a platform admin viewing another shop sees THAT
  // shop's connection state. Mirrors the carfax/autoflow/protractor/
  // integrations routes and the Data Status panel.
  const session = await getSession();
  return session?.shopId ? String(session.shopId) : null;
}

export async function GET(_request: NextRequest) {
  try {
    const shopId = await getUserShopId();
    if (!shopId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const db = await getDb();
    const shop = await db.collection('shops').findOne(
      { shopId: { $in: [shopId, Number(shopId)] } },
      { projection: { shopware: 1 } }
    );

    if (!shop?.shopware?.tenantId) {
      return NextResponse.json({ configured: false });
    }

    // Watchdog: mirrors the Tekmetric GET (task #437 / 2026-05-18 fix).
    // If the in-process initial-sync promise was lost to a Render restart,
    // the shops doc would be stuck at "running" forever. After ~15 minutes
    // flip the UI to "failed" so the spinner stops — the nightly cron
    // catches up regardless. Read-only — just reported as failed until
    // the next successful sync writes a steady state back.
    let initialSyncState: "running" | "complete" | "failed" =
      shop.shopware.initialSyncState ?? "complete";
    let initialSyncError: string | null = shop.shopware.initialSyncError ?? null;
    if (initialSyncState === "running") {
      const startedAt = shop.shopware.initialSyncStartedAt
        ? new Date(shop.shopware.initialSyncStartedAt).getTime()
        : 0;
      if (startedAt && Date.now() - startedAt > 15 * 60 * 1000) {
        initialSyncState = "failed";
        initialSyncError =
          initialSyncError || "Initial sync didn't finish in 15 minutes — nightly sync will catch up.";
      }
    }

    return NextResponse.json({
      configured: true,
      tenantId: shop.shopware.tenantId,
      swShopId: shop.shopware.swShopId,
      shopName: shop.shopware.shopName ?? null,
      connectedAt: shop.shopware.connectedAt ?? null,
      lastSyncAt: shop.shopware.lastSyncAt ?? null,
      initialSyncState,
      initialSyncVehicles: shop.shopware.initialSyncVehicles ?? null,
      initialSyncError,
    });
  } catch (err: any) {
    console.error('[Shop-Ware Settings] GET error:', err.message);
    return NextResponse.json({ error: err.message || 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const userShopId = await getUserShopId();
    if (!userShopId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!isConfigured()) {
      return NextResponse.json(
        { error: 'Shop-Ware partner credentials not configured. Please contact support.' },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { tenantId, swShopId, tenantSubdomain } = body;

    if (!swShopId) {
      return NextResponse.json({ error: 'swShopId is required' }, { status: 400 });
    }

    const swShopIdNum = parseInt(String(swShopId), 10);
    const tenantIdNum = tenantId ? parseInt(String(tenantId), 10) : swShopIdNum;

    if (isNaN(swShopIdNum) || isNaN(tenantIdNum)) {
      return NextResponse.json({ error: 'Shop ID must be a number' }, { status: 400 });
    }

    const connTest = await testConnection(tenantIdNum);
    if (!connTest.ok) {
      // Task #1064: Shop-Ware 404s both nonexistent tenants AND tenants
      // that never authorized our Partner API. Map that to a friendly,
      // actionable message (no raw JSON/URL blob) and — when the partner
      // authorizations list is reachable — suggest the tenant whose shops
      // include the entered Shop ID.
      if (isShopWareNotFound(connTest.error)) {
        let suggestedTenantId: number | null = null;
        try {
          const auths = await getPartnerAuthorizations();
          const tenantShopIds = new Map<number, number[]>();
          // Cap the per-tenant shop lookups so a large partner list can't
          // stall the Connect POST; suggestion is best-effort.
          const candidates = auths.slice(0, 15);
          await Promise.all(
            candidates.map(async (a) => {
              try {
                const shops = await getShops(a.tenant_id);
                tenantShopIds.set(a.tenant_id, shops.map((s) => s.id));
              } catch {
                // skip tenants whose shop lookup fails
              }
            })
          );
          suggestedTenantId = suggestTenantId(auths, tenantIdNum, swShopIdNum, tenantShopIds);
        } catch (authErr: any) {
          console.warn(`[Shop-Ware Settings] Authorizations cross-check failed (non-fatal): ${authErr?.message || authErr}`);
        }

        return NextResponse.json(
          {
            error: buildTenantConnectError({
              enteredTenantId: tenantIdNum,
              enteredShopId: swShopIdNum,
              usedShopIdFallback: !tenantId,
              suggestedTenantId,
            }),
          },
          { status: 400 }
        );
      }

      return NextResponse.json(
        { error: connTest.error || 'Could not connect to Shop-Ware. Check your Tenant ID.' },
        { status: 400 }
      );
    }

    let shopName: string | undefined;
    try {
      const swShop = await getShop(tenantIdNum, swShopIdNum);
      shopName = swShop.name;
    } catch {
      return NextResponse.json(
        { error: `Shop ID ${swShopIdNum} not found in tenant ${tenantIdNum}. Check your Shop ID.` },
        { status: 400 }
      );
    }

    const db = await getDb();
    await db.collection('shops').updateOne(
      { shopId: { $in: [userShopId, Number(userShopId)] } },
      {
        $set: {
          'shopware.tenantId': tenantIdNum,
          'shopware.swShopId': swShopIdNum,
          'shopware.shopName': shopName,
          'shopware.connectedAt': new Date(),
          'shopware.lastSyncAt': null,
          // Initial-sync state mirrors the Tekmetric Connect parity fix
          // (task #437): POST returns the instant the shops doc is
          // written; the prewarm + first backfill chunk run in the
          // background and flip this to "complete"/"failed" so the UI
          // can surface progress without a manual refresh. The GET
          // watchdog cleans up if the in-process promise dies.
          'shopware.initialSyncState': 'running',
          'shopware.initialSyncStartedAt': new Date(),
          ...(tenantSubdomain ? { 'shopware.tenantSubdomain': tenantSubdomain } : {}),
        },
        $unset: {
          'shopware.initialSyncError': '',
          'shopware.initialSyncFinishedAt': '',
          'shopware.initialSyncVehicles': '',
        },
      },
      { upsert: true }
    );

    console.log(`[Shop-Ware Settings] Connected shop ${userShopId} → tenant ${tenantIdNum} / shop ${swShopIdNum} (${shopName})`);

    // Pre-warm `shopware_repair_orders` (and downstream `job_index`)
    // for the most recent invoiced ROs, then trigger the backfill cron
    // so the very first chunk lands at cache-hit speed rather than
    // re-paginating Shop-Ware for data we just ingested. Mirrors the
    // Tekmetric onboarding pattern from task #59 — see
    // lib/shopware-jobs-prewarm.ts for why SW's prewarm also advances
    // the backfill cursor (SW has no per-RO cache the cron consults).
    // Fire-and-forget so the settings POST returns promptly; the
    // prewarm awaits internally so the cron sees the advanced cursor.
    (async () => {
      const numericShopId = Number(userShopId);
      let initialSyncError: string | null = null;
      try {
        await prewarmShopWareJobsCacheForOnboarding(numericShopId, tenantIdNum, swShopIdNum);
      } catch (warmErr: any) {
        console.warn(
          `[Shop-Ware Settings] Cache prewarm failed (non-fatal) for shop ${numericShopId}: ${warmErr?.message || warmErr}`
        );
        initialSyncError = warmErr?.message || 'prewarm failed';
      }
      await triggerShopWareBackfillCron(numericShopId);

      // Count vehicles imported during onboarding. Prewarm + the first
      // backfill chunk both populate `shopware_vehicles`; we surface
      // that count as the parity "imported N vehicles" line in the UI.
      let initialSyncVehicles = 0;
      try {
        initialSyncVehicles = await db
          .collection('shopware_vehicles')
          .countDocuments({ mosShopId: numericShopId });
      } catch {}

      await db.collection('shops').updateOne(
        { shopId: { $in: [userShopId, Number(userShopId)] } },
        {
          $set: {
            'shopware.initialSyncState': initialSyncError ? 'failed' : 'complete',
            'shopware.initialSyncFinishedAt': new Date(),
            'shopware.initialSyncVehicles': initialSyncVehicles,
            ...(initialSyncError ? { 'shopware.initialSyncError': initialSyncError } : {}),
          },
          ...(initialSyncError ? {} : { $unset: { 'shopware.initialSyncError': '' } }),
        }
      ).catch(() => {});
    })();

    return NextResponse.json({
      success: true,
      tenantId: tenantIdNum,
      swShopId: swShopIdNum,
      shopName,
      initialSync: { state: 'running' },
      jobHistoryBackfill: 'queued',
    });
  } catch (err: any) {
    console.error('[Shop-Ware Settings] POST error:', err.message);
    return NextResponse.json({ error: err.message || 'Failed to save settings' }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest) {
  try {
    const userShopId = await getUserShopId();
    if (!userShopId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const db = await getDb();
    await db.collection('shops').updateOne(
      { shopId: { $in: [userShopId, Number(userShopId)] } },
      { $unset: { shopware: '' } }
    );

    console.log(`[Shop-Ware Settings] Disconnected shop ${userShopId}`);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[Shop-Ware Settings] DELETE error:', err.message);
    return NextResponse.json({ error: err.message || 'Failed to disconnect' }, { status: 500 });
  }
}
