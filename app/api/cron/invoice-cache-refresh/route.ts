/**
 * Daily Invoice Cache Refresh Cron (task #71)
 *
 * Why: `protractor_invoice_cache` (and the Shop-Ware analogue, populated
 * via the SW jobs prewarm) has a 30d TTL on `cachedAt` enforced by
 * `getCachedProtractorInvoice`. For shops where the regular backfill
 * has already caught up to the present, nothing else is touching the
 * recent window — so cached invoices fall off and the next backfill
 * verification pass pays the full `/Invoice/{id}` cost again.
 *
 * What: Daily, for every connected Protractor and Shop-Ware shop,
 * re-run the prewarm with a much shorter lookback (7d) to keep the
 * most-recent week warm without burning API budget.
 *
 * Notes:
 *   - The Shop-Ware prewarm is invoked with `advanceCursor: false` so
 *     this is a pure cache top-up — it does NOT advance
 *     `shopware_backfill_progress.currentChunkEnd`. That field is
 *     reserved for the onboarding prewarm, where skipping the prewarmed
 *     window is the whole point.
 *   - Per-shop errors are swallowed so one bad shop doesn't fail the
 *     batch. The prewarm functions already handle their own
 *     alerting / shop-level status stamping.
 *   - Auth mirrors the other crons (Bearer CRON_SECRET or `?secret=`).
 *
 * Trigger manually:
 *   GET /api/cron/invoice-cache-refresh
 *   with Authorization: Bearer {CRON_SECRET}  (or ?secret={CRON_SECRET})
 *
 * Optional query params:
 *   ?lookbackDays=N   override the 7d default (e.g. 14 to backstop a
 *                     missed cron run)
 *   ?provider=protractor|shopware  refresh only one provider
 *   ?shopId=N         refresh a single shop (still requires that shop
 *                     to be configured for the chosen provider)
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { prewarmProtractorJobsCacheForOnboarding } from "@/lib/protractor-jobs-prewarm";
import { prewarmShopWareJobsCacheForOnboarding } from "@/lib/shopware-jobs-prewarm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;
const DEFAULT_LOOKBACK_DAYS = 7;

function isAuthorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return true;
  const header = req.headers.get("authorization");
  const param = req.nextUrl.searchParams.get("secret");
  return header === `Bearer ${CRON_SECRET}` || param === CRON_SECRET;
}

interface ProtractorShopResult {
  shopId: number;
  ok: boolean;
  invoicesScanned?: number;
  invoicesCached?: number;
  alreadyCached?: number;
  errors?: number;
  capped?: boolean;
  durationMs?: number;
  error?: string;
}

interface ShopWareShopResult {
  shopId: number;
  ok: boolean;
  rosFetched?: number;
  rosStored?: number;
  jobsIndexed?: number;
  jobsSkipped?: number;
  errors?: number;
  capped?: boolean;
  durationMs?: number;
  error?: string;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const url = req.nextUrl;
  const lookbackParam = url.searchParams.get("lookbackDays");
  const lookbackDays = lookbackParam
    ? Math.max(1, parseInt(lookbackParam, 10) || DEFAULT_LOOKBACK_DAYS)
    : DEFAULT_LOOKBACK_DAYS;
  const providerFilter = url.searchParams.get("provider");
  const shopIdFilter = url.searchParams.get("shopId");
  const targetShopId = shopIdFilter ? Number(shopIdFilter) : null;

  console.log(
    `[Invoice Cache Refresh] Starting (lookback=${lookbackDays}d` +
      `${providerFilter ? `, provider=${providerFilter}` : ""}` +
      `${targetShopId != null ? `, shopId=${targetShopId}` : ""})`
  );

  const db = await getDb();
  const protractorResults: ProtractorShopResult[] = [];
  const shopwareResults: ShopWareShopResult[] = [];

  if (!providerFilter || providerFilter === "protractor") {
    // Mirror the connected-shop predicate used by /api/cron/protractor-sync
    // so this cron stays in lockstep with the rest of the Protractor
    // pipeline if onboarding ever moves to a different field.
    const protractorShops = await db
      .collection("shops")
      .find(
        {
          $or: [
            { "protractor.apiKey": { $exists: true, $nin: [null, ""] } },
            { protractorApiKey: { $exists: true, $nin: [null, ""] } },
            { "protractor.connectionId": { $exists: true, $nin: [null, ""] } },
            { protractorConnectionId: { $exists: true, $nin: [null, ""] } },
          ],
        },
        { projection: { shopId: 1 } }
      )
      .toArray();

    const filtered = targetShopId != null
      ? protractorShops.filter((s) => Number(s.shopId) === targetShopId)
      : protractorShops;

    console.log(
      `[Invoice Cache Refresh] Protractor: ${filtered.length} shop(s) to refresh`
    );

    for (const shop of filtered) {
      const shopId = Number(shop.shopId);
      try {
        const result = await prewarmProtractorJobsCacheForOnboarding(shopId, {
          lookbackDays,
        });
        protractorResults.push({
          shopId,
          ok: true,
          invoicesScanned: result.invoicesScanned,
          invoicesCached: result.invoicesCached,
          alreadyCached: result.alreadyCached,
          errors: result.errors,
          capped: result.capped,
          durationMs: result.durationMs,
        });
      } catch (err: any) {
        const message = err?.message || String(err);
        console.error(
          `[Invoice Cache Refresh] Protractor shop ${shopId} threw: ${message}`
        );
        protractorResults.push({ shopId, ok: false, error: message });
      }
    }
  }

  if (!providerFilter || providerFilter === "shopware") {
    // Same predicate as /api/cron/shopware-sync: a shop is "connected"
    // iff it has a `shopware.tenantId` set.
    const shopwareShops = await db
      .collection("shops")
      .find(
        { "shopware.tenantId": { $exists: true, $ne: null } },
        {
          projection: {
            shopId: 1,
            "shopware.tenantId": 1,
            "shopware.swShopId": 1,
          },
        }
      )
      .toArray();

    const filtered = targetShopId != null
      ? shopwareShops.filter((s) => Number(s.shopId) === targetShopId)
      : shopwareShops;

    console.log(
      `[Invoice Cache Refresh] Shop-Ware: ${filtered.length} shop(s) to refresh`
    );

    for (const shop of filtered) {
      const shopId = Number(shop.shopId);
      const tenantId = Number(shop.shopware?.tenantId);
      const swShopId = Number(shop.shopware?.swShopId);
      if (!tenantId || !swShopId) {
        console.warn(
          `[Invoice Cache Refresh] Shop-Ware shop ${shopId} missing tenantId/swShopId; skipping`
        );
        shopwareResults.push({
          shopId,
          ok: false,
          error: "missing tenantId or swShopId",
        });
        continue;
      }
      try {
        const result = await prewarmShopWareJobsCacheForOnboarding(
          shopId,
          tenantId,
          swShopId,
          { lookbackDays, advanceCursor: false }
        );
        shopwareResults.push({
          shopId,
          ok: !result.error,
          rosFetched: result.rosFetched,
          rosStored: result.rosStored,
          jobsIndexed: result.jobsIndexed,
          jobsSkipped: result.jobsSkipped,
          errors: result.errors,
          capped: result.capped,
          durationMs: result.durationMs,
          error: result.error,
        });
      } catch (err: any) {
        const message = err?.message || String(err);
        console.error(
          `[Invoice Cache Refresh] Shop-Ware shop ${shopId} threw: ${message}`
        );
        shopwareResults.push({ shopId, ok: false, error: message });
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  const summary = {
    ok: true,
    lookbackDays,
    durationMs,
    protractor: {
      shopsProcessed: protractorResults.length,
      shopsFailed: protractorResults.filter((r) => !r.ok).length,
      invoicesCached: protractorResults.reduce(
        (s, r) => s + (r.invoicesCached ?? 0),
        0
      ),
      results: protractorResults,
    },
    shopware: {
      shopsProcessed: shopwareResults.length,
      shopsFailed: shopwareResults.filter((r) => !r.ok).length,
      rosStored: shopwareResults.reduce((s, r) => s + (r.rosStored ?? 0), 0),
      jobsIndexed: shopwareResults.reduce(
        (s, r) => s + (r.jobsIndexed ?? 0),
        0
      ),
      results: shopwareResults,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(
    `[Invoice Cache Refresh] Done in ${durationMs}ms — ` +
      `Protractor: ${summary.protractor.shopsProcessed} shops, ${summary.protractor.invoicesCached} cached; ` +
      `Shop-Ware: ${summary.shopware.shopsProcessed} shops, ${summary.shopware.rosStored} ROs, ${summary.shopware.jobsIndexed} jobs`
  );

  return NextResponse.json(summary);
}
