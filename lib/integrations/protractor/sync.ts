import { getDb } from "@/lib/mongo";
import {
  resolveProtractorConfig,
  protractorFetch,
  fetchInvoiceById,
  fetchVehicleById,
  runWithProtractorBackoffTracking,
  getCachedProtractorInvoice,
  cacheProtractorInvoice,
} from "./client";
import { extractJobIndexFromWorkOrder, updatePartCrossReferences, computeJobHash } from "@/lib/job-index";
import { createIngestionService } from "@/lib/integrations/core/normalized-ingestion";
import { getPaceConfig, midpoint, describePace, getBackfillYears, reopenCompletedShopsForHorizon } from "@/lib/integrations/backfill-pace";
import { prepareQuietWindowGate, applyQuietWindowGate } from "@/lib/data/repositories/activity-profiles";
import {
  findServiceItem,
  upsertServiceItem,
} from "@/lib/data/repositories/protractor-service-items";
import * as backfillProgress from "@/lib/data/repositories/protractor-backfill-progress";
import pLimit from "p-limit";
import { detectDviLinksFromProtractorInvoice, isDviLinkIngestEnabled } from "@/lib/dvi-links/ingest";

const MAX_WALL_CLOCK_MS = 1800000; // 30 minutes max
// Per-chunk metrics rolling window. Mirrors the Tekmetric backfill cap so the
// admin sync-health view can compute median/p95 chunk duration per shop
// without grepping cron logs. 25 entries is enough headroom to spot a
// regression while keeping the progress doc small.
const RECENT_CHUNK_METRICS_LIMIT = 25;

async function fetchInvoicesForDateRange(
  shopId: number,
  startDate: string,
  endDate: string,
  maxPages: number = 50
): Promise<{ invoices: any[]; hitPageCap: boolean; hadError: boolean }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) return { invoices: [], hitPageCap: false, hadError: false };

  const allInvoices: any[] = [];
  const pageSize = 100;
  let skip = 0;
  const seenIds = new Set<string>();
  let pageCount = 0;
  let hadError = false;
  let lastPageWasFull = false;

  while (pageCount < maxPages) {
    const params = new URLSearchParams();
    params.set("startDate", startDate);
    params.set("endDate", endDate);
    params.set("take", String(pageSize));
    params.set("skip", String(skip));

    const result = await protractorFetch<{ ItemCollection?: any[] }>(
      `/Invoice/?${params.toString()}`,
      config
    );

    if (!result.ok) {
      console.error(`[Backfill] Shop ${shopId} Invoice error at skip=${skip}:`, result.error);
      hadError = true;
      break;
    }

    const pageItems = result.data?.ItemCollection || [];
    let newItems = 0;

    for (const item of pageItems) {
      if (item.ID && !seenIds.has(item.ID)) {
        seenIds.add(item.ID);
        allInvoices.push(item);
        newItems++;
      }
    }

    lastPageWasFull = pageItems.length >= pageSize;
    if (newItems === 0 || pageItems.length === 0) break;
    if (!lastPageWasFull) break;

    skip += pageSize;
    pageCount++;
    await new Promise(r => setTimeout(r, 30));
  }

  const hitPageCap = pageCount >= maxPages && lastPageWasFull;
  return { invoices: allInvoices, hitPageCap, hadError };
}

async function getOrFetchVehicle(
  db: any,
  shopId: number,
  serviceItemId: string,
  rateLimiter: ReturnType<typeof pLimit>,
  cacheCounters?: { hits: number; misses: number }
): Promise<{ vin?: string; year?: number; make?: string; model?: string; engine?: string } | null> {
  if (!serviceItemId) return null;
  
  const cached = await findServiceItem(shopId, serviceItemId);
  
  if (cached) {
    if (cacheCounters) cacheCounters.hits++;
    return {
      vin: cached.vin ?? undefined,
      year: cached.year ?? undefined,
      make: cached.make ?? undefined,
      model: cached.model ?? undefined,
      engine: cached.engine ?? undefined,
    };
  }

  if (cacheCounters) cacheCounters.misses++;

  const result = await rateLimiter(async () => {
    return fetchVehicleById(shopId, serviceItemId);
  });
  
  if (result.ok && result.vehicle) {
    const v = result.vehicle;
    const vehicleData = {
      shopId,
      serviceItemId,
      vin: v.VIN || null,
      year: v.Year ? parseInt(String(v.Year)) : null,
      make: v.Make || null,
      model: v.Model || null,
      engine: v.Engine || null,
      fetchedAt: new Date(),
    };
    
    await upsertServiceItem(shopId, serviceItemId, vehicleData);
    
    return {
      vin: vehicleData.vin || undefined,
      year: vehicleData.year || undefined,
      make: vehicleData.make || undefined,
      model: vehicleData.model || undefined,
      engine: vehicleData.engine || undefined,
    };
  }
  
  return null;
}

// Builds the per-chunk metrics object persisted on `backfill_progress`.
// Mirrors the shape used by the Tekmetric backfill so the
// `summarizeChunkMetrics` helper in the admin sync-health route can render
// it without a provider-specific branch. Slot mapping for Protractor:
// - vehicles* -> `protractor_service_items` cache hits/misses (real cache)
// - jobs* -> `protractor_invoice_cache` hits/misses (the per-RO cache the
//   onboarding pre-warm in lib/protractor-jobs-prewarm.ts populates and
//   that backfillShopChunk consults before each `/Invoice/{id}` fetch).
//   Reused as the `jobsCache*` slot so the existing chunk-speed roll-up
//   in the admin sync-health view (`summarizeChunkMetrics`) and the
//   "Jobs cache" column in the chunk-speed table light up automatically
//   for Protractor — no provider-specific branch needed. When the chunk
//   processed zero ROs we report 0/0 -> null so an empty chunk doesn't
//   show a fake "0% hit rate" regression.
// - customers* -> NULL/0 (no per-customer fetch in the backfill path).
function buildProtractorChunkMetrics(input: {
  now: Date;
  durationMs: number;
  roCount: number;
  chunkStart: Date;
  chunkEnd: Date;
  nextChunkEnd: Date;
  advanceMode: string;
  // Bulk-fetch flow metrics: invoices served straight from the `/Invoice/`
  // list (no detail API call) vs. those that needed a `/Invoice/{id}`
  // detail fallback. These reuse the `jobsCache*` metric fields the admin
  // sync-health view already renders — a high "hit rate" now means the
  // list-richness optimization is working (most invoices avoided detail).
  listExtractedCount: number;
  detailFallbackCount: number;
  vehiclesCacheHits: number;
  vehiclesCacheMisses: number;
  backoffDeltaMs: number;
  chunkHadError: boolean;
  hitPageCap: boolean;
}) {
  const vehTotal = input.vehiclesCacheHits + input.vehiclesCacheMisses;
  const invTotal = input.listExtractedCount + input.detailFallbackCount;
  return {
    at: input.now,
    durationMs: input.durationMs,
    roCount: input.roCount,
    chunkStart: input.chunkStart,
    chunkEnd: input.chunkEnd,
    nextChunkEnd: input.nextChunkEnd,
    advanceMode: input.advanceMode,
    jobsCacheHits: input.listExtractedCount,
    jobsCacheMisses: input.detailFallbackCount,
    jobsCacheHitRate:
      invTotal > 0
        ? Number((input.listExtractedCount / invTotal).toFixed(4))
        : null,
    vehiclesCacheHits: input.vehiclesCacheHits,
    vehiclesCacheMisses: input.vehiclesCacheMisses,
    vehiclesCacheHitRate:
      vehTotal > 0
        ? Number((input.vehiclesCacheHits / vehTotal).toFixed(4))
        : null,
    customersCacheHits: 0,
    customersCacheMisses: 0,
    customersCacheHitRate: null,
    backoff429Ms: Math.round(input.backoffDeltaMs),
    chunkHadError: input.chunkHadError,
    hitPageCap: input.hitPageCap,
    perRoExceptions: 0,
  };
}

async function backfillShopChunk(
  db: any, 
  shopId: number,
  _rateLimiter: ReturnType<typeof pLimit>
): Promise<{ jobsIndexed: number; skipped: number; complete: boolean; message: string; vehiclesFetched: number; normalizedCount: number }> {
  // Per-chunk speed metrics. Captured here and persisted at the end of the
  // chunk so a regression in vehicle cache hit rate or a backoff spike is
  // visible in the admin sync-health view without grepping cron logs.
  // Mirrors the Tekmetric backfill instrumentation. The backoff figure is
  // sourced from a per-chunk AsyncLocalStorage counter (see
  // `runWithProtractorBackoffTracking` in protractor.ts) so concurrent
  // chunks don't leak each other's retry waits into this chunk's metric.
  // Task #460: wrap in `withChunkWriteCounters` so PG/Mongo/rate-limiter
  // write fan-out is captured in `backfill_chunk_metrics` for cadence
  // measurement. AsyncLocalStorage-scoped — only fires inside this chunk.
  const { withChunkWriteCounters } = await import("@/lib/backfill-metrics/write-counters");
  const { recordChunkMetric } = await import("@/lib/backfill-metrics/chunk-metrics");
  return withChunkWriteCounters(async (chunkWriteCounters) => {
  const _metricStartedAt = Date.now();
  let _metricOutcome: "ok" | "error" | "deferred" | "complete" | "empty" = "ok";
  let _metricRos = 0;
  let _metricBackoffMs = 0;
  try {
  return await runWithProtractorBackoffTracking(async (chunkBackoffCounter) => {
  const chunkStartedAt = Date.now();
  const vehicleCacheCounters = { hits: 0, misses: 0 };

  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { jobsIndexed: 0, skipped: 0, complete: false, message: "Not configured", vehiclesFetched: 0, normalizedCount: 0 };
  }
  
  const shop = await db.collection("shops").findOne({ shopId });
  const enterpriseId = shop?.enterpriseId;
  const pace = getPaceConfig("protractor", shop?.timezone, new Date());
  const rateLimiter = pLimit(pace.concurrency);
  
  const ingestionService = createIngestionService(
    db,
    'protractor',
    shopId,
    enterpriseId,
    { 
      syncRunId: `backfill-${Date.now()}`,
      createAuditLog: false,
      dualWriteToJobIndex: false,
      dualWriteToRepairPatterns: true,
    }
  );

  let progress = await backfillProgress.findByShop(shopId);
  
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  
  const yearsToBackfill = getBackfillYears();
  const oldestDate = new Date();
  oldestDate.setFullYear(oldestDate.getFullYear() - yearsToBackfill);
  oldestDate.setHours(0, 0, 0, 0);
  
  let chunkEnd: Date;
  
  if (progress?.currentChunkEnd && progress?.logicVersion === 4) {
    chunkEnd = new Date(progress.currentChunkEnd);
    console.log(`[Backfill] Shop ${shopId}: Resuming from ${chunkEnd.toISOString().split('T')[0]} (logicVersion=${progress.logicVersion})`);
  } else {
    chunkEnd = new Date(today);
    console.log(`[Backfill] Shop ${shopId}: Starting fresh (logicVersion=${progress?.logicVersion || 'none'})`);
    await backfillProgress.upsertMerge(shopId, {
      set: {
        shopId,
        startedAt: new Date(),
        currentChunkEnd: chunkEnd,
        completed: false,
        logicVersion: 4,
      },
      unset: ["currentChunkStart"],
    });
  }

  let daysToProcess = pace.chunkDays;
  const lastCount = progress?.lastInvoiceCount;
  if (lastCount) {
    const dense = pace.isOffHours ? 3500 : 1500;
    const heavy = pace.isOffHours ? 1800 : 800;
    const medium = pace.isOffHours ? 900 : 400;
    const light = pace.isOffHours ? 300 : 150;
    if (lastCount > dense) {
      daysToProcess = Math.max(21, Math.floor(pace.chunkDays / 3));
    } else if (lastCount > heavy) {
      daysToProcess = Math.max(30, Math.floor(pace.chunkDays / 2));
    } else if (lastCount > medium) {
      daysToProcess = Math.max(45, Math.floor(pace.chunkDays * 0.75));
    } else if (lastCount < light) {
      daysToProcess = Math.min(180, Math.floor(pace.chunkDays * 1.5));
    }
  }

  // Time-based shrink. The invoice-count heuristic above sizes a chunk by how
  // MANY records the previous chunk pulled, but a chunk can also run long for
  // reasons count doesn't capture (slow downstream, detail-fallback fan-out).
  // If the previous chunk overran the per-chunk time budget, cut the window so
  // the next chunk fetches AND commits its cursor inside one drain turn.
  // Without this, a giant shop's chunk keeps getting interrupted before it
  // records progress, so its cursor never advances and it re-walks the same
  // window forever (the duplicate-key write churn seen on the most-behind
  // shops). Floors at 7 days and caps the shrink factor so one slow chunk
  // can't pin the window to the floor permanently — a later fast chunk grows
  // it back via the count heuristic. Implausible durations (> the wall-clock
  // cap, i.e. corrupt metrics) are ignored. Tunable via PROTRACTOR_TARGET_CHUNK_MS.
  const lastDurationMs = Number(progress?.lastChunkMetrics?.durationMs) || 0;
  const targetChunkMs = Math.max(
    15000,
    Number(process.env.PROTRACTOR_TARGET_CHUNK_MS) || 120000,
  );
  if (lastDurationMs > targetChunkMs && lastDurationMs <= MAX_WALL_CLOCK_MS) {
    const overrunFactor = Math.min(4, Math.ceil(lastDurationMs / targetChunkMs));
    daysToProcess = Math.max(7, Math.floor(daysToProcess / overrunFactor));
  }

  // Interrupted-attempt shrink (task #946). The time-based shrink above only
  // fires when the previous chunk FINISHED and persisted its metrics. A chunk
  // that gets killed mid-flight (wall-clock cap, worker deadline, process
  // death) writes nothing, so the next attempt re-walks the exact same window
  // at the exact same size — forever, on a shop dense enough to always blow
  // the cap. We persist a `pendingAttempt` marker at chunk start and clear it
  // when the chunk commits its cursor; if we arrive here and the marker is
  // still present for the SAME cursor position, the previous attempt died
  // mid-chunk and we halve the window (floored at 7 days, and never larger
  // than what the dead attempt tried) so each retry walks a strictly smaller
  // window until one fits inside the budget and the cursor finally advances.
  const pendingAttempt = progress?.pendingAttempt;
  if (
    pendingAttempt?.chunkEnd &&
    new Date(pendingAttempt.chunkEnd).getTime() === chunkEnd.getTime()
  ) {
    const priorDays = Number(pendingAttempt.days) || daysToProcess;
    const shrunk = Math.max(7, Math.floor(Math.min(daysToProcess, priorDays) / 2));
    if (shrunk < daysToProcess || priorDays <= 7) {
      console.warn(
        `[Backfill] Shop ${shopId}: previous attempt at cursor ${chunkEnd.toISOString().split("T")[0]} ` +
          `(${priorDays}d window, started ${pendingAttempt.startedAt ? new Date(pendingAttempt.startedAt).toISOString() : "?"}) ` +
          `never committed — shrinking window ${daysToProcess}d -> ${shrunk}d so the cursor can advance`,
      );
    }
    daysToProcess = shrunk;
  }
  await backfillProgress.upsertMerge(shopId, {
    set: {
      pendingAttempt: {
        chunkEnd,
        days: daysToProcess,
        startedAt: new Date(),
      },
    },
  });
  
  const chunkStart = new Date(chunkEnd);
  chunkStart.setDate(chunkStart.getDate() - daysToProcess);
  if (chunkStart < oldestDate) {
    chunkStart.setTime(oldestDate.getTime());
  }

  if (chunkEnd <= oldestDate) {
    await backfillProgress.upsertMerge(shopId, {
      set: { completed: true, completedAt: new Date() },
    });
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { protractorBackfillComplete: true, protractorBackfillCompletedAt: new Date() } }
    );
    return { jobsIndexed: 0, skipped: 0, complete: true, message: "Already complete", vehiclesFetched: 0, normalizedCount: 0 };
  }

  const startStr = chunkStart.toISOString().split("T")[0];
  const endStr = chunkEnd.toISOString().split("T")[0];

  console.log(`[Backfill] Shop ${shopId}: ${startStr} to ${endStr} (${daysToProcess} days) horizon=${yearsToBackfill}y`);

  let jobsIndexed = 0;
  let skippedUnchanged = 0;
  let vehiclesFetched = 0;

  const fetchResult = await fetchInvoicesForDateRange(shopId, startStr, endStr, pace.maxPagesPerChunk);
  const invoices = fetchResult.invoices;
  let chunkHadError = fetchResult.hadError;
  const hitPageCap = fetchResult.hitPageCap;
  console.log(`[Backfill] Shop ${shopId}: ${invoices.length} invoices ${describePace(pace)} ${hitPageCap ? "[HIT PAGE CAP]" : ""}${chunkHadError ? " [HAD ERROR]" : ""}`);

  if (invoices.length === 0) {
    // Empty chunk: if it was empty due to error, hold cursor; else advance.
    const nextChunkEnd = chunkHadError ? chunkEnd : chunkStart;
    const isComplete = !chunkHadError && nextChunkEnd <= oldestDate;
    const emptyChunkMetrics = buildProtractorChunkMetrics({
      now: new Date(),
      durationMs: Date.now() - chunkStartedAt,
      roCount: 0,
      chunkStart,
      chunkEnd,
      nextChunkEnd,
      advanceMode: chunkHadError ? "HOLD (empty chunk after error)" : "FULL (empty chunk)",
      // Empty chunk: no invoices extracted and no detail fallbacks. 0/0 ->
      // null hit rate so an empty chunk doesn't drag down the rolling average.
      listExtractedCount: 0,
      detailFallbackCount: 0,
      vehiclesCacheHits: vehicleCacheCounters.hits,
      vehiclesCacheMisses: vehicleCacheCounters.misses,
      backoffDeltaMs: chunkBackoffCounter.ms,
      chunkHadError,
      hitPageCap: false,
    });
    const priorEmptyMetrics: any[] = Array.isArray(progress?.recentChunkMetrics)
      ? progress.recentChunkMetrics
      : [];
    const nextEmptyRecent = [emptyChunkMetrics, ...priorEmptyMetrics].slice(
      0,
      RECENT_CHUNK_METRICS_LIMIT,
    );
    await backfillProgress.upsertMerge(shopId, {
      set: {
        currentChunkEnd: nextChunkEnd,
        lastRunAt: new Date(),
        lastInvoiceCount: 0,
        completed: isComplete,
        ...(isComplete ? { completedAt: new Date() } : {}),
        ...(chunkHadError
          ? { lastError: "empty chunk after error", lastErrorAt: new Date() }
          : { lastError: null, lastErrorAt: null }),
        lastChunkMetrics: emptyChunkMetrics,
        recentChunkMetrics: nextEmptyRecent,
      },
      // Chunk committed its cursor decision — clear the interrupted-attempt
      // marker so the next chunk isn't treated as a re-walk (task #946).
      unset: ["pendingAttempt"],
    });
    if (isComplete) {
      await db.collection("shops").updateOne(
        { shopId },
        { $set: { protractorBackfillComplete: true, protractorBackfillCompletedAt: new Date() } }
      );
    }
    return { jobsIndexed: 0, skipped: 0, complete: isComplete, message: `${startStr} to ${endStr}: 0 invoices${chunkHadError ? " (HOLD)" : ""}`, vehiclesFetched: 0, normalizedCount: 0 };
  }

  const allJobEntries: any[] = [];
  const serviceItemIds = new Set<string>();
  const invoicesForNormalized: any[] = [];
  let invoiceDetailErrors = 0;

  // Bulk-fetch path (mirror AppFueled). Probe #583
  // (docs/protractor-list-vs-detail-probe-2026-06-05.md) confirmed that the
  // `/Invoice/?startDate&endDate` LIST already carries full ServicePackages +
  // ServicePackageLines (and DeferredServicePackages) at parity with
  // `/Invoice/{id}` detail for our API tier. So we extract job entries
  // straight from each list row and SKIP the per-invoice `fetchInvoiceById`
  // N+1 that used to dominate backfill runtime (tens of thousands of throttled
  // detail calls for a multi-year shop).
  //
  // Detail-on-mismatch safety net: a list row that yields no extractable line
  // items but carries a non-zero `Total` is treated as "thin" — its lines must
  // live only on detail (a different tier/shop, or an unusual record). For just
  // those we do a single bounded, rate-limited `/Invoice/{id}` fetch
  // (cache-first, reusing any prewarmed `protractor_invoice_cache` payload).
  // This is the invoice-path analogue of AppFueled's "detail only for
  // open/in-progress ROs": invoices are terminal so there is no open-RO concept
  // on this endpoint, but a thin list row is the equivalent case still needing
  // detail.
  //
  // `listExtractedCount` / `detailFallbackCount` replace the old invoice-cache
  // hit/miss counters: with the per-invoice fetch gone, the meaningful signal
  // is "how many invoices were served straight from the list (cheap) vs needed
  // a detail fallback (expensive)".
  let listExtractedCount = 0;
  let detailFallbackCount = 0;
  let detailFallbackCapHit = false;
  // Cap the fallback fan-out so a systematically-thin list (e.g. a tier
  // regression) can't silently collapse the chunk back into a full per-invoice
  // N+1. Past the cap we stop issuing detail fetches and hold the cursor with
  // an [OPS-ALERT] so on-call investigates, rather than quietly paying the old
  // cost or advancing over invoices indexed without line items.
  const maxDetailFallbacks = Math.max(25, Math.ceil(invoices.length * 0.1));

  await Promise.all(
    invoices.map((inv: any) =>
      rateLimiter(async () => {
        try {
          let source: any = inv;
          let jobEntries = extractJobIndexFromWorkOrder(shopId, inv, "protractor");

          const listRowIsThin =
            jobEntries.length === 0 &&
            typeof inv.Total === "number" &&
            inv.Total > 0;

          if (listRowIsThin) {
            if (detailFallbackCount >= maxDetailFallbacks) {
              detailFallbackCapHit = true;
            } else {
              detailFallbackCount++;
              // Cache-first so a prewarmed/previously-fetched payload avoids
              // even the fallback API call.
              let fullInv = await getCachedProtractorInvoice(db, shopId, inv.ID).catch(
                (cacheErr: any) => {
                  console.warn(
                    `[Backfill] Shop ${shopId}: invoice cache lookup failed for ${inv.ID}: ${cacheErr?.message || cacheErr}`
                  );
                  return null;
                }
              );

              if (!fullInv) {
                const detailResult = await fetchInvoiceById(shopId, inv.ID);
                if (!detailResult.ok || !detailResult.invoice) {
                  invoiceDetailErrors++;
                  return;
                }
                fullInv = detailResult.invoice;
                // Warm the cache for next time. Stable post-invoice payloads
                // mean this upsert is safe and cheap.
                await cacheProtractorInvoice(db, shopId, inv.ID, fullInv).catch(
                  (cacheErr: any) => {
                    console.warn(
                      `[Backfill] Shop ${shopId}: invoice cache write failed for ${inv.ID}: ${cacheErr?.message || cacheErr}`
                    );
                  }
                );
              }

              source = fullInv;
              jobEntries = extractJobIndexFromWorkOrder(shopId, fullInv, "protractor");
            }
          } else {
            listExtractedCount++;
          }

          invoicesForNormalized.push(source);

          if (source.ServiceItemID) {
            serviceItemIds.add(source.ServiceItemID);
          }

          if (jobEntries.length > 0) {
            for (const entry of jobEntries) {
              (entry as any)._serviceItemId = source.ServiceItemID;
            }
            allJobEntries.push(...jobEntries);
          }
        } catch (err) {
          invoiceDetailErrors++;
        }
      })
    )
  );

  // Task #860: scan synced invoices for public DVI share links (AutoServe1,
  // AutoVitals avlink.io, AutoFlow microsites, etc.) and register them for
  // the flag-gated fetch pipeline. No-op unless DVI_LINK_INGEST_ENABLED=true
  // (checked inside); registration failures never break a sync.
  if (isDviLinkIngestEnabled()) {
    for (const inv of invoicesForNormalized) {
      await detectDviLinksFromProtractorInvoice({ shopId, invoice: inv }).catch(
        () => {},
      );
    }
  }

  if (invoiceDetailErrors > 0) {
    chunkHadError = true;
    console.warn(`[Backfill] Shop ${shopId}: ${invoiceDetailErrors}/${invoices.length} invoice-detail fallback fetches failed; will hold cursor`);
  }

  if (detailFallbackCapHit) {
    chunkHadError = true;
    console.warn(
      `[Backfill] Shop ${shopId}: [OPS-ALERT] detail-fallback cap (${maxDetailFallbacks}) hit — ` +
        `${detailFallbackCount}+ thin list rows this chunk. The /Invoice/ list may have stopped ` +
        `carrying line items for this shop/tier; holding cursor instead of advancing over ` +
        `possibly-incomplete data.`
    );
  }

  console.log(
    `[Backfill] Shop ${shopId}: ${allJobEntries.length} jobs, ${serviceItemIds.size} unique vehicles to fetch ` +
      `(list-extracted: ${listExtractedCount}/${invoices.length}, detail-fallback: ${detailFallbackCount}${detailFallbackCapHit ? " [CAP HIT]" : ""})`
  );

  const vehicleCache = new Map<string, any>();
  const vehicleIdsToFetch = Array.from(serviceItemIds).filter(id => {
    const entry = allJobEntries.find(e => (e as any)._serviceItemId === id);
    return entry && (!entry.vehicle?.vin && !entry.vehicle?.year);
  });

  if (vehicleIdsToFetch.length > 0) {
    console.log(`[Backfill] Shop ${shopId}: Fetching ${vehicleIdsToFetch.length} vehicles in parallel...`);
    
    const vehicleResults = await Promise.all(
      vehicleIdsToFetch.map(serviceItemId => 
        rateLimiter(async () => {
          const vehicleData = await getOrFetchVehicle(db, shopId, serviceItemId, rateLimiter, vehicleCacheCounters);
          return { serviceItemId, vehicleData };
        })
      )
    );
    
    for (const { serviceItemId, vehicleData } of vehicleResults) {
      if (vehicleData) {
        vehicleCache.set(serviceItemId, vehicleData);
        vehiclesFetched++;
      }
    }
  }

  for (const entry of allJobEntries) {
    const serviceItemId = (entry as any)._serviceItemId;
    if (serviceItemId && vehicleCache.has(serviceItemId)) {
      const vehicleData = vehicleCache.get(serviceItemId);
      entry.vehicle = {
        ...entry.vehicle,
        ...vehicleData,
        serviceItemId,
      };
    }
    delete (entry as any)._serviceItemId;
  }

  const bulkOps: any[] = [];
  const existingJobsFilters = allJobEntries.map(entry => ({
    shopId: entry.shopId,
    workOrderId: entry.workOrderId,
    servicePackageId: entry.servicePackageId,
  }));
  
  const existingJobs = await db.collection("job_index").find({
    $or: existingJobsFilters.length > 0 ? existingJobsFilters : [{ _id: null }]
  }).toArray();
  
  const existingJobMap = new Map<string, string>();
  for (const job of existingJobs) {
    const key = `${job.shopId}:${job.workOrderId}:${job.servicePackageId}`;
    existingJobMap.set(key, job.contentHash);
  }
  
  for (const entry of allJobEntries) {
    const contentHash = computeJobHash(entry);
    const key = `${entry.shopId}:${entry.workOrderId}:${entry.servicePackageId}`;
    
    if (existingJobMap.get(key) === contentHash) {
      skippedUnchanged++;
      continue;
    }
    
    bulkOps.push({
      updateOne: {
        filter: { 
          shopId: entry.shopId, 
          workOrderId: entry.workOrderId, 
          servicePackageId: entry.servicePackageId 
        },
        update: { $set: { ...entry, contentHash, sourceSystem: "protractor" } },
        upsert: true
      }
    });
  }

  if (bulkOps.length > 0) {
    const bulkResult = await db.collection("job_index").bulkWrite(bulkOps, { ordered: false });
    jobsIndexed = bulkResult.upsertedCount + bulkResult.modifiedCount;
    console.log(`[Backfill] Shop ${shopId}: Bulk wrote ${jobsIndexed} jobs (${bulkResult.upsertedCount} new, ${bulkResult.modifiedCount} updated, ${skippedUnchanged} skipped)`);
  }

  let normalizedCount = 0;
  try {
    const normalizedResult = await ingestionService.ingestWorkOrderBatchWithAllEntities(invoicesForNormalized);
    normalizedCount = normalizedResult.workOrders.created + normalizedResult.workOrders.updated;
    console.log(`[Backfill] Shop ${shopId}: Normalized ${normalizedCount} WOs`);
  } catch (normalizedError) {
    console.error(`[Backfill] Shop ${shopId}: Normalized ingestion error:`, normalizedError);
  }

  let nextChunkEnd: Date;
  let advanceMode: string;
  if (chunkHadError) {
    nextChunkEnd = chunkEnd;
    advanceMode = "HOLD (error in chunk)";
  } else if (hitPageCap) {
    nextChunkEnd = midpoint(chunkStart, chunkEnd);
    advanceMode = `SPLIT (page cap hit, advancing only to ${nextChunkEnd.toISOString().split('T')[0]})`;
  } else {
    nextChunkEnd = chunkStart;
    advanceMode = "FULL";
  }
  const isComplete = !chunkHadError && !hitPageCap && nextChunkEnd <= oldestDate;

  console.log(`[Backfill] Shop ${shopId}: ${advanceMode} — currentChunkEnd ${chunkEnd.toISOString().split('T')[0]} -> ${nextChunkEnd.toISOString().split('T')[0]}`);

  // Compute per-chunk speed metrics. The backoff value comes from a
  // per-chunk AsyncLocalStorage counter so concurrent chunks (same
  // process, different shop) cannot leak each other's retry waits into
  // this chunk's metric.
  // Bulk-fetch flow counts for this chunk: `listExtractedCount` is the
  // invoices served straight from the `/Invoice/` list (the cheap path),
  // `detailFallbackCount` is the thin list rows that needed a single
  // `/Invoice/{id}` detail fallback. Together they reuse the `jobsCache*`
  // metric fields the admin sync-health view renders; a high "hit rate"
  // means the list-richness optimization is doing its job.
  const chunkMetrics = buildProtractorChunkMetrics({
    now: new Date(),
    durationMs: Date.now() - chunkStartedAt,
    roCount: invoices.length,
    chunkStart,
    chunkEnd,
    nextChunkEnd,
    advanceMode,
    listExtractedCount,
    detailFallbackCount,
    vehiclesCacheHits: vehicleCacheCounters.hits,
    vehiclesCacheMisses: vehicleCacheCounters.misses,
    backoffDeltaMs: chunkBackoffCounter.ms,
    chunkHadError,
    hitPageCap,
  });
  const priorChunkMetrics: any[] = Array.isArray(progress?.recentChunkMetrics)
    ? progress.recentChunkMetrics
    : [];
  const nextRecentChunkMetrics = [chunkMetrics, ...priorChunkMetrics].slice(
    0,
    RECENT_CHUNK_METRICS_LIMIT,
  );

  console.log(
    `[Backfill] Shop ${shopId}: chunk metrics ` +
      `duration=${chunkMetrics.durationMs}ms ros=${invoices.length} ` +
      `listExtracted=${listExtractedCount}/${listExtractedCount + detailFallbackCount} ` +
      `vehiclesCache=${vehicleCacheCounters.hits}/${vehicleCacheCounters.hits + vehicleCacheCounters.misses} ` +
      `backoff=${chunkMetrics.backoff429Ms}ms`,
  );

  await backfillProgress.upsertMerge(shopId, {
    set: {
      currentChunkEnd: nextChunkEnd,
      lastRunAt: new Date(),
      lastInvoiceCount: invoices.length,
      completed: isComplete,
      ...(isComplete ? { completedAt: new Date() } : {}),
      ...(chunkHadError
        ? { lastError: "chunk had errors, holding cursor", lastErrorAt: new Date() }
        : { lastError: null, lastErrorAt: null }),
      lastChunkMetrics: chunkMetrics,
      recentChunkMetrics: nextRecentChunkMetrics,
    },
    inc: { totalJobsIndexed: jobsIndexed },
    // Chunk committed its cursor decision — clear the interrupted-attempt
    // marker so the next chunk isn't treated as a re-walk (task #946).
    unset: ["pendingAttempt"],
  });

  if (isComplete) {
    await db.collection("shops").updateOne(
      { shopId },
      { $set: { protractorBackfillComplete: true, protractorBackfillCompletedAt: new Date() } }
    );
    console.log(`[Backfill] Shop ${shopId}: Marked protractorBackfillComplete=true`);
  }
  
  _metricRos = invoices.length;
  _metricBackoffMs = Math.round(chunkBackoffCounter.ms);
  _metricOutcome = chunkHadError ? "error" : isComplete ? "complete" : "ok";
  return {
    jobsIndexed,
    skipped: skippedUnchanged,
    complete: isComplete,
    message: `${startStr} to ${endStr}: ${jobsIndexed} jobs, ${vehiclesFetched} vehicles fetched, ${normalizedCount} normalized, ${daysToProcess}d chunk`,
    vehiclesFetched,
    normalizedCount
  };
  });
  } catch (err) {
    _metricOutcome = "error";
    throw err;
  } finally {
    await recordChunkMetric({
      provider: "protractor",
      shopId,
      chunkStartedAt: _metricStartedAt,
      rosProcessed: _metricRos,
      outcome: _metricOutcome,
      backoffMs: _metricBackoffMs,
      counters: chunkWriteCounters,
    });
  }
  });
}

export async function runProtractorBackfill(
  shopId: number,
  options: { singlePass?: boolean; maxChunks?: number } = {},
): Promise<{
  chunksProcessed: number;
  totalJobsIndexed: number;
  complete: boolean;
  error?: string;
}> {
  // `singlePass` runs at most one batch (`maxChunksPerRun` chunks) and
  // returns immediately, skipping the self-recursion at the end of this
  // function and the auto-retry chain in the catch path. The platform-admin
  // "Run chunk now" endpoint sets this so a single HTTP request fits inside
  // the route's `maxDuration` budget and always returns chunk metrics
  // inline. Scheduled cron callers (which want full "run until complete")
  // leave the option unset and keep the existing behaviour.
  //
  // `maxChunks` caps how many chunks this call walks (clamped to the pace
  // profile's `maxChunksPerRun`). The round-robin drain sets a small cap so
  // each shop takes a short turn and then yields to the next shop, instead of
  // one giant shop monopolising a worker for the whole 30-min wall clock and
  // starving everyone behind it.
  const singlePass = options.singlePass === true;
  const startTime = Date.now();
  const db = await getDb();
  const rateLimiter = pLimit(5);
  
  let chunksProcessed = 0;
  let totalJobsIndexed = 0;
  let complete = false;

  // Atomic lock acquisition with stale-lock recovery.
  //
  // Historical bug: if the process died mid-run (Render redeploy, OOM, etc.)
  // the recursive chain at the bottom of this function never got to clear
  // `inProgress: false`, so the flag stayed `true` in Mongo forever. Every
  // subsequent cron tick saw the stuck flag and bailed out with
  // "Already in progress", stranding the shop indefinitely. As of 2026-05-02
  // this had stranded 14 of 17 Protractor backfills for 7-30 days.
  //
  // Fix: claim the lock if EITHER (a) inProgress isn't true, OR (b) the lock
  // is stale (no `lastActivityAt` update in STALE_THRESHOLD_MS — currently
  // 30 min). `lastActivityAt` is refreshed after every chunk inside the
  // backfill loop, so a healthy run's lock is always fresh; a process death
  // freezes that timestamp and the next cron run reclaims after 30 minutes.
  //
  // The `upsert: true` is kept for first-time-init (no existing doc). When
  // the doc exists with a fresh lock, the filter doesn't match, the upsert
  // tries to insert and hits the unique `shopId` index — we catch the
  // resulting DuplicateKey (code 11000) and treat it as the legitimate
  // "Already in progress" signal instead of letting the outer try/catch
  // misclassify it as a backfill error.
  const staleLockThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
  const lockResult = await backfillProgress.acquireLease(
    shopId,
    staleLockThreshold,
    new Date(),
  );

  if (!lockResult) {
    // Defensive: shouldn't be reachable with `upsert: true`, but kept for
    // safety in case driver behavior changes.
    console.log(`[Backfill] Shop ${shopId}: Skipping - another instance already in progress`);
    return { chunksProcessed: 0, totalJobsIndexed: 0, complete: false, error: 'Already in progress' };
  }

  console.log(`[Backfill] Starting inline backfill for shop ${shopId}`);

  const shopDoc = await db.collection("shops").findOne({ shopId });
  const shopTz = (shopDoc as any)?.timezone || "America/Chicago";
  const runPace = getPaceConfig("protractor", shopTz);
  const maxChunksPerRun = runPace.maxChunksPerRun;
  const chunkCap =
    options.maxChunks && options.maxChunks > 0
      ? Math.min(options.maxChunks, maxChunksPerRun)
      : maxChunksPerRun;

  try {
    while (chunksProcessed < chunkCap) {
      if (Date.now() - startTime > MAX_WALL_CLOCK_MS) {
        console.log(`[Backfill] Shop ${shopId}: Wall clock limit reached after ${chunksProcessed} chunks`);
        break;
      }

      const result = await backfillShopChunk(db, shopId, rateLimiter);
      chunksProcessed++;
      totalJobsIndexed += result.jobsIndexed;

      console.log(`[Backfill] Shop ${shopId} chunk ${chunksProcessed}: ${result.message}`);
      
      await backfillProgress.upsertMerge(shopId, {
        set: { lastActivityAt: new Date() },
      });

      if (result.complete) {
        complete = true;
        break;
      }

      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[Backfill] Shop ${shopId}: Run finished - ${chunksProcessed} chunks, ${totalJobsIndexed} jobs indexed, complete: ${complete}`);
    
    await backfillProgress.upsertMerge(shopId, {
      set: { inProgress: false, lastCompletedRunAt: new Date() },
    });
    
    if (!complete) {
      if (singlePass) {
        console.log(`[Backfill] Shop ${shopId}: Single-pass mode — returning without chaining the next run`);
      } else {
        console.log(`[Backfill] Shop ${shopId}: Not complete, starting next run immediately`);
        try {
          const nextResult = await runProtractorBackfill(shopId);
          console.log(`[Backfill] Shop ${shopId}: Next run result:`, nextResult.complete ? 'COMPLETE' : `${nextResult.chunksProcessed} more chunks`);
        } catch (err: any) {
          console.error(`[Backfill] Shop ${shopId}: Next run failed:`, err.message);
        }
      }
    } else {
      console.log(`[Backfill] Shop ${shopId}: FULLY COMPLETE!`);
    }
    
    return { chunksProcessed, totalJobsIndexed, complete };
  } catch (err: any) {
    console.error(`[Backfill] Shop ${shopId}: Error during backfill:`, err.message);
    
    const progress = await backfillProgress.findByShop(shopId);
    const retryCount = ((progress?.retryCount as number) || 0) + 1;
    const MAX_RETRIES = 5;
    
    await backfillProgress.upsertMerge(shopId, {
      set: {
        inProgress: false,
        lastError: err.message,
        lastErrorAt: new Date(),
        retryCount,
      },
    });
    
    if (singlePass) {
      // Skip the auto-retry chain in single-pass mode — the run-now endpoint
      // surfaces the error inline so on-call decides whether to retry, and
      // we don't want to leave background timers running past the HTTP
      // response.
      console.log(`[Backfill] Shop ${shopId}: Single-pass mode — skipping auto-retry`);
    } else if (retryCount <= MAX_RETRIES) {
      const backoffMs = Math.min(30000, 5000 * retryCount);
      console.log(`[Backfill] Shop ${shopId}: Auto-retry ${retryCount}/${MAX_RETRIES} in ${backoffMs/1000}s...`);
      setTimeout(() => {
        runProtractorBackfill(shopId).catch(retryErr => {
          console.error(`[Backfill] Shop ${shopId}: Retry failed:`, retryErr.message);
        });
      }, backoffMs);
    } else {
      console.error(`[Backfill] Shop ${shopId}: Max retries (${MAX_RETRIES}) exceeded, giving up`);
    }
    
    return { chunksProcessed, totalJobsIndexed, complete: false, error: err.message };
  }
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export async function findAndResumeStaleBackfills(): Promise<{
  resumed: number;
  shopIds: number[];
}> {
  const db = await getDb();
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  // Horizon-raise reopen: if the operator raised BACKFILL_HORIZON_YEARS, clear
  // the completion flag on configured shops that still have deeper history to
  // walk so the stale-resume query below re-includes them and resumes from
  // their parked cursor. No-op until the horizon is actually raised.
  const configuredForReopen = await db
    .collection("shops")
    .find({ "protractor.configured": true })
    .project({ shopId: 1 })
    .toArray();
  await reopenCompletedShopsForHorizon({
    db,
    progressCollection: "backfill_progress",
    providerLabel: "Backfill",
    shopFlagField: "protractorBackfillComplete",
    eligibleShopIds: configuredForReopen
      .map((s: any) => Number(s.shopId))
      .filter((n: number) => Number.isFinite(n)),
  });

  const [staleBackfills, protractorShops] = await Promise.all([
    db.collection("backfill_progress").find({
      completed: { $ne: true },
      $or: [
        { lastAttemptedAt: { $lt: staleThreshold } },
        { lastAttemptedAt: { $exists: false }, lastRunAt: { $lt: staleThreshold } },
        { inProgress: true, lastAttemptedAt: { $lt: staleThreshold } },
        // Catch docs that crashed before writing any chunk-completion timestamp.
        // These have `inProgress: true` + `startedAt` from months ago but no
        // `lastRunAt` / `lastAttemptedAt`. Without this branch the previous
        // three clauses can never match them and the doc is stuck forever.
        {
          inProgress: true,
          lastAttemptedAt: { $exists: false },
          lastRunAt: { $exists: false },
          startedAt: { $lt: staleThreshold },
        },
      ]
    }).toArray(),
    db.collection("shops").find({ "protractor.configured": true }).project({ shopId: 1 }).toArray()
  ]);
  
  const configuredShopIds = new Set(protractorShops.map((s: any) => s.shopId));
  const shopIds: number[] = [];

  // Smart per-shop quiet-window gate (task #662). OFF by default: no DB read,
  // no logging, no behavior change. Built once before the resume loop.
  const quietGate = await prepareQuietWindowGate(
    staleBackfills
      .map((p: any) => Number(p.shopId))
      .filter((n: number) => configuredShopIds.has(n)),
  );

  for (const progress of staleBackfills) {
    if (!configuredShopIds.has(progress.shopId)) continue;

    if (applyQuietWindowGate(quietGate, Number(progress.shopId), "protractor").shouldSkip) {
      continue;
    }

    console.log(`[Backfill] Resuming stale backfill for shop ${progress.shopId}`);
    shopIds.push(progress.shopId);
    
    runProtractorBackfill(progress.shopId).then(result => {
      console.log(`[Backfill] Shop ${progress.shopId} resumed backfill completed:`, result);
    }).catch(err => {
      console.error(`[Backfill] Shop ${progress.shopId} resumed backfill failed:`, err.message);
    });
  }
  
  if (shopIds.length > 0) {
    console.log(`[Backfill] Started ${shopIds.length} parallel backfills (each shop has isolated API rate limits)`);
  }
  
  return { resumed: shopIds.length, shopIds };
}

// New-shop fastpath knobs. Mirrors the Tekmetric `?fastpath=newShops`
// cron: Protractor shops onboarded within this window are eligible for
// the every-5-min fast lane so a freshly onboarded client sees their
// history populate in minutes instead of waiting for the daily 02:00 UTC
// tick or the 15-min boost windows. Env-tunable, mirroring
// TEKMETRIC_NEW_SHOP_FASTPATH_DAYS. Read per-call so the window can be
// dialed without a redeploy (the in-process cron stays warm for days).
function getNewShopFastpathDays(): number {
  return Math.max(1, Number(process.env.PROTRACTOR_NEW_SHOP_FASTPATH_DAYS) || 14);
}
// Small per-tick budget so the fast lane stays light (it fires every 5
// min, far more often than the boosts) and stays focused on the handful
// of genuinely brand-new shops. Mirrors the Tekmetric FASTPATH cap.
const FASTPATH_MAX_SHOPS_PER_RUN = 3;

// Test seam — swapped in smoke tests so the selection logic can be
// exercised against a fake Mongo without launching real backfills.
export const __fastpathDeps = {
  getDb,
  // Progress reads go through the repository (flag-gated Mongo/PG since
  // task #999); exposed here so smoke tests can stub the read alongside
  // the fake Mongo handle instead of hitting the real store.
  findProgressForShops: backfillProgress.findProgressForShops,
  runBackfill: (shopId: number): void => {
    // Fire-and-forget, mirroring `findAndResumeStaleBackfills`.
    // `runProtractorBackfill` claims the per-shop in-flight/stale lock,
    // so a shop already being drained by the daily/boost run is a no-op
    // here (its lock is fresh), and the rate limiter inside the backfill
    // keeps us under Protractor's API ceiling.
    runProtractorBackfill(shopId)
      .then((result) =>
        console.log(`[Backfill] Shop ${shopId} fastpath run completed:`, result),
      )
      .catch((err) =>
        console.error(`[Backfill] Shop ${shopId} fastpath run failed:`, err.message),
      );
  },
};

/**
 * Every-5-min "new shop honeymoon" fast lane for Protractor.
 *
 * Selects Protractor-configured shops created within the last
 * NEW_SHOP_FASTPATH_DAYS days whose backfill is not yet complete, caps
 * the set at FASTPATH_MAX_SHOPS_PER_RUN, and kicks each one through the
 * existing resume/drain core (`runProtractorBackfill`), which owns the
 * per-shop in-flight/stale lock and the rate limiter. Shops that have
 * completed their backfill, or have aged past the new-shop window, drop
 * off the fast lane and are left to the normal daily/boost cadence.
 */
export async function findAndRunNewShopFastpath(): Promise<{
  processed: number;
  shopIds: number[];
}> {
  const db = await __fastpathDeps.getDb();
  const fastpathDays = getNewShopFastpathDays();
  const cutoff = new Date(
    Date.now() - fastpathDays * 24 * 60 * 60 * 1000,
  );

  // Protractor-configured shops onboarded inside the new-shop window.
  const newShops = await db
    .collection("shops")
    .find({ "protractor.configured": true, createdAt: { $gte: cutoff } })
    .project({ shopId: 1 })
    .toArray();

  if (newShops.length === 0) {
    console.log(
      `[Protractor Backfill] fastpath=newShops: no shops created in last ${fastpathDays}d`,
    );
    return { processed: 0, shopIds: [] };
  }

  const newShopIds = newShops.map((s: any) => Number(s.shopId));

  // Drop shops whose backfill is already complete; brand-new shops with
  // no progress doc yet are kept (they need the backfill the most).
  const progressDocs = await __fastpathDeps.findProgressForShops(newShopIds);
  const completedShopIds = new Set(
    progressDocs
      .filter((p) => p.completed === true)
      .map((p) => Number(p.shopId)),
  );

  const eligible = newShopIds
    .filter((id) => !completedShopIds.has(id))
    .slice(0, FASTPATH_MAX_SHOPS_PER_RUN);

  console.log(
    `[Protractor Backfill] fastpath=newShops: ${eligible.length} of ${newShopIds.length} new shop(s) (created in last ${fastpathDays}d) need backfill`,
  );

  for (const shopId of eligible) {
    __fastpathDeps.runBackfill(shopId);
  }

  return { processed: eligible.length, shopIds: eligible };
}
