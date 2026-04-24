import pLimit from "p-limit";
import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchInvoiceById,
  cacheProtractorInvoice,
} from "@/lib/integrations/protractor";

// Onboarding pre-warm scope. The first Protractor backfill chunk is the
// most recent `chunkDays` window (60 day-time / 120 night per
// lib/integrations/backfill-pace.ts), so warming the most recent 90d
// covers the day-time chunk plus a margin and gives the very first
// chunk a near-100% cache-hit rate. We also cap the absolute number of
// `/Invoice/{id}` calls so that a high-volume shop can't burn the
// entire Protractor quota in one onboarding pass — the uncached tail
// will still get warmed opportunistically by `backfillShopChunk` as
// the cron walks back through history (it now writes to
// `protractor_invoice_cache` as a side effect of every fetch).
const PREWARM_LOOKBACK_DAYS = 90;
const PREWARM_MAX_INVOICES = 500;
const PREWARM_LIST_PAGE_SIZE = 100;
const PREWARM_LIST_MAX_PAGES = 10;
const PREWARM_CONCURRENCY = 3;

// Mirror the freshness window used by `getCachedProtractorInvoice` in
// lib/integrations/protractor.ts (TTL = 30d). We mirror rather than
// import the constant to avoid widening that module's surface; a
// regression here is caught the moment the backfill fails to hit a
// row this prewarm wrote.
const PREWARM_FRESH_CACHE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface PrewarmProtractorJobsCacheOptions {
  lookbackDays?: number;
  maxInvoices?: number;
  concurrency?: number;
}

export interface PrewarmProtractorJobsCacheResult {
  shopId: number;
  lookbackDays: number;
  invoicesScanned: number;
  alreadyCached: number;
  invoicesCached: number;
  errors: number;
  durationMs: number;
  capped: boolean;
}

/**
 * One-shot pre-warm for `protractor_invoice_cache` at fresh-shop
 * onboarding — the Protractor analogue of
 * `prewarmTekmetricJobsCacheForOnboarding` (task #59).
 *
 * Background: the Protractor backfill (`backfillShopChunk` in
 * lib/integrations/protractor-backfill.ts) lists invoices in a date
 * range via `/Invoice/?startDate=…&endDate=…` and then fans out one
 * `/Invoice/{id}` call per RO to get full service-package detail.
 * That per-invoice fan-out is the dominant API cost on a fresh-shop's
 * first chunk. The backfill now checks `protractor_invoice_cache`
 * before each `fetchInvoiceById`, so pre-warming that cache for the
 * recent terminal-invoice window means the very first chunk hits
 * Mongo instead of Protractor for every invoice in scope.
 *
 * Idempotent: repeated calls skip invoices whose
 * `protractor_invoice_cache` row already exists and is still fresh
 * (within the 30d TTL that `getCachedProtractorInvoice` enforces).
 * Re-warming a stale row is a safe upsert.
 */
export async function prewarmProtractorJobsCacheForOnboarding(
  shopId: number,
  options: PrewarmProtractorJobsCacheOptions = {}
): Promise<PrewarmProtractorJobsCacheResult> {
  const lookbackDays = options.lookbackDays ?? PREWARM_LOOKBACK_DAYS;
  const maxInvoices = options.maxInvoices ?? PREWARM_MAX_INVOICES;
  const concurrency = options.concurrency ?? PREWARM_CONCURRENCY;

  const start = Date.now();
  const db = await getDb();

  const result: PrewarmProtractorJobsCacheResult = {
    shopId,
    lookbackDays,
    invoicesScanned: 0,
    alreadyCached: 0,
    invoicesCached: 0,
    errors: 0,
    durationMs: 0,
    capped: false,
  };

  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    result.durationMs = Date.now() - start;
    console.log(
      `[Protractor Prewarm] Shop ${shopId}: not configured, skipping prewarm`
    );
    return result;
  }

  const today = new Date();
  const startDate = new Date(today.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const startStr = startDate.toISOString().split("T")[0];
  const endStr = today.toISOString().split("T")[0];

  console.log(
    `[Protractor Prewarm] Shop ${shopId}: listing invoices ${startStr} → ${endStr} (lookback=${lookbackDays}d, cap=${maxInvoices})`
  );

  // List invoices in the recent window. We mirror the listing logic in
  // `fetchInvoicesForDateRange` (protractor-backfill.ts) rather than
  // call it directly so the cap on listing pages here can be tighter
  // than the per-chunk backfill cap — onboarding shouldn't burn the
  // backfill's full quota.
  const invoiceIds: string[] = [];
  const seen = new Set<string>();
  let skip = 0;
  let pageCount = 0;
  let listingHadError = false;

  while (pageCount < PREWARM_LIST_MAX_PAGES && invoiceIds.length < maxInvoices) {
    const params = new URLSearchParams();
    params.set("startDate", startStr);
    params.set("endDate", endStr);
    params.set("take", String(PREWARM_LIST_PAGE_SIZE));
    params.set("skip", String(skip));

    const listResult = await protractorFetch<{ ItemCollection?: any[] }>(
      `/Invoice/?${params.toString()}`,
      config
    );

    if (!listResult.ok) {
      console.warn(
        `[Protractor Prewarm] Shop ${shopId}: failed to list invoices at skip=${skip}: ${listResult.error}`
      );
      result.errors++;
      listingHadError = true;
      break;
    }

    const pageItems = listResult.data?.ItemCollection || [];
    if (pageItems.length === 0) break;

    for (const item of pageItems) {
      if (item?.ID && !seen.has(item.ID)) {
        seen.add(item.ID);
        invoiceIds.push(item.ID);
        if (invoiceIds.length >= maxInvoices) {
          result.capped = true;
          break;
        }
      }
    }

    if (pageItems.length < PREWARM_LIST_PAGE_SIZE) break;
    if (result.capped) break;

    skip += PREWARM_LIST_PAGE_SIZE;
    pageCount++;
    await new Promise(r => setTimeout(r, 30));
  }

  result.invoicesScanned = invoiceIds.length;

  if (invoiceIds.length === 0) {
    result.durationMs = Date.now() - start;
    console.log(
      `[Protractor Prewarm] Shop ${shopId}: no invoices in last ${lookbackDays}d${listingHadError ? " (listing had error)" : ""}; nothing to warm`
    );
    await stampShopPrewarmStatus(db, shopId, result);
    return result;
  }

  // Skip invoices whose cache row is still fresh. A row whose
  // `cachedAt` is past the 30d TTL would be ignored by
  // `getCachedProtractorInvoice` during backfill, so skipping it here
  // would leave the backfill cold-cache for that invoice.
  const freshCachedAtCutoff = new Date(
    Date.now() - PREWARM_FRESH_CACHE_WINDOW_MS
  );
  const existing = await db
    .collection("protractor_invoice_cache")
    .find(
      {
        shopId,
        invoiceId: { $in: invoiceIds },
        cachedAt: { $gt: freshCachedAtCutoff },
      },
      { projection: { invoiceId: 1, _id: 0 } }
    )
    .toArray();
  const cachedSet = new Set<string>(existing.map((d: any) => String(d.invoiceId)));
  result.alreadyCached = cachedSet.size;

  const toFetch = invoiceIds.filter((id) => !cachedSet.has(id));

  console.log(
    `[Protractor Prewarm] Shop ${shopId}: ${invoiceIds.length} invoice(s) in window, ${cachedSet.size} already cached, fetching ${toFetch.length} (concurrency=${concurrency})`
  );

  const limit = pLimit(concurrency);
  await Promise.all(
    toFetch.map((invoiceId) =>
      limit(async () => {
        try {
          const detailResult = await fetchInvoiceById(shopId, invoiceId);
          if (!detailResult.ok || !detailResult.invoice) {
            result.errors++;
            console.warn(
              `[Protractor Prewarm] Shop ${shopId}: invoice fetch failed for ${invoiceId}: ${detailResult.error || "no invoice"}`
            );
            return;
          }
          await cacheProtractorInvoice(db, shopId, invoiceId, detailResult.invoice);
          result.invoicesCached++;
        } catch (err: any) {
          result.errors++;
          console.warn(
            `[Protractor Prewarm] Shop ${shopId}: invoice fetch threw for ${invoiceId}: ${err?.message || err}`
          );
        }
      })
    )
  );

  result.durationMs = Date.now() - start;

  console.log(
    `[Protractor Prewarm] Shop ${shopId} done: scanned=${result.invoicesScanned} alreadyCached=${result.alreadyCached} cached=${result.invoicesCached} errors=${result.errors} capped=${result.capped} ${result.durationMs}ms`
  );

  await stampShopPrewarmStatus(db, shopId, result);
  return result;
}

async function stampShopPrewarmStatus(
  db: any,
  shopId: number,
  result: PrewarmProtractorJobsCacheResult
): Promise<void> {
  try {
    await db.collection("shops").updateOne(
      { shopId: { $in: [shopId, String(shopId)] as any } },
      {
        $set: {
          "protractor.invoiceCachePrewarm": {
            completedAt: new Date(),
            lookbackDays: result.lookbackDays,
            invoicesScanned: result.invoicesScanned,
            alreadyCached: result.alreadyCached,
            invoicesCached: result.invoicesCached,
            errors: result.errors,
            capped: result.capped,
            durationMs: result.durationMs,
          },
        },
      }
    );
  } catch (err: any) {
    console.warn(
      `[Protractor Prewarm] Shop ${shopId}: failed to stamp shop status: ${err?.message || err}`
    );
  }
}
