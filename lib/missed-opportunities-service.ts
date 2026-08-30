/**
 * Task #1146 — server-side evaluation for the "Missed Opportunities"
 * report over recently closed repair orders.
 *
 * Data flow (bounded, cache-only — never hammers upstream SMS APIs and
 * never triggers a plan rebuild):
 *   1. Pull terminal ROs in the window from the CANONICAL PG normalized
 *      stores (normalized_work_orders + normalized_service_jobs), capped
 *      at MAX_ROS_PER_RUN newest-first.
 *   2. For each unique VIN, read the vehicle's cached VHI plan (Mongo
 *      cached_plans / PG cache facade via the plan-cache repository) with
 *      bounded concurrency. Cache miss => the RO is "not evaluated".
 *   3. Reconcile each cached due recommendation against ticket work into
 *      performed, deferred/declined, or not-quoted outcomes.
 *
 * Results are cached per (shop, window) in Mongo by the caller (the API
 * route) so page loads serve the cache and recompute at most every
 * REPORT_TTL_MS.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { buildCloseDateSincePredicate } from "@/lib/missed-opportunities-query";
import { getDb as getPg } from "@/lib/db/drizzle";
import {
  normalizedWorkOrders,
  normalizedServiceJobs,
  normalizedLineItems,
} from "@/lib/db/schema/normalized";
import { findCachedPlansForVehicles } from "@/lib/data/repositories/missed-opportunities";
import {
  findCachedWorkOrdersByIds,
  findDisplayRoNumbersByIds,
  type ProtractorWorkOrderCacheDoc,
} from "@/lib/data/repositories/protractor-work-orders";
import {
  findCachedInvoiceSnapshotsByIds,
  type ProtractorInvoiceSnapshotDoc,
} from "@/lib/data/repositories/protractor-invoices";
import {
  findInvoiceCacheEntriesByIds,
  type ProtractorInvoiceCacheDoc,
} from "@/lib/data/repositories/protractor-invoice-cache";
import {
  planItemsFromBuckets,
  evaluateMissedOpportunityRecommendations,
  missedItemsFromRecommendations,
  summarizeMissedOpportunities,
  MISSED_OPPORTUNITY_REPORT_VERSION,
  type MissedOpportunityReport,
  type MissedOpportunityRo,
  type MissedOppWindow,
} from "@/lib/missed-opportunities";
import {
  classifyTicketJobStatus,
  normalizeTicketJobAmount,
  resolveProtractorRecordedAmount,
  type MissedOpportunityTicketJob,
} from "@/lib/missed-opportunity-ticket-details";
import {
  extractProtractorServicePackages,
  getRecordedProtractorPackageTotal,
  matchNormalizedServiceJobsToCachedProtractorPackages,
  resolveCachedProtractorPackageStatus,
} from "@/lib/integrations/protractor/package-normalization";
import {
  PROVIDER_CACHE_ENRICHMENT_BUDGET_MS,
  protractorSourceIdsByType,
  withinProviderCacheBudget,
} from "@/lib/missed-opportunities-provider-cache";

/** Hard cap on ROs evaluated per run — large shops degrade to "newest N". */
export const MAX_ROS_PER_RUN = 300;
/** Serve-from-cache TTL used by the API route. */
export const REPORT_TTL_MS = 30 * 60 * 1000;

/** RO statuses that mean the ticket is closed/terminal. */
const TERMINAL_STATUSES = ["invoiced", "paid", "closed", "archived"] as const;

export async function computeMissedOpportunityReport(
  shopId: number,
  windowDays: MissedOppWindow,
): Promise<MissedOpportunityReport> {
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  let providerCacheEnrichmentMs = 0;
  let providerCacheBudgetRemainingMs = PROVIDER_CACHE_ENRICHMENT_BUDGET_MS;
  const finishStage = (stage: string, stageStartedAt: number) => {
    timings[stage] = Date.now() - stageStartedAt;
  };
  const pg = getPg();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Closed ROs in window, newest close first. completed_date fills for
  // providers that never stamp closedDate. This exact 2-arg coalesce
  // expression is served by nwo_shop_close_date_idx
  // (drizzle/0032_task1183_nwo_close_date_idx.sql) — keep the expression
  // in sync with that index or the query degrades to a multi-second
  // shop_id scan on large shops (Task #1183).
  const closeDate = sql<Date | null>`coalesce(${normalizedWorkOrders.closedDate}, ${normalizedWorkOrders.completedDate})`;
  let stageStartedAt = Date.now();
  const wos = await pg
    .select({
      id: normalizedWorkOrders.id,
      workOrderNumber: normalizedWorkOrders.workOrderNumber,
      status: normalizedWorkOrders.status,
      closedAt: closeDate,
      vehicle: normalizedWorkOrders.vehicle,
      odometerOut: normalizedWorkOrders.odometerOut,
      odometerIn: normalizedWorkOrders.odometerIn,
      serviceAdvisorName: normalizedWorkOrders.serviceAdvisorName,
      provenance: normalizedWorkOrders.provenance,
      rawData: normalizedWorkOrders.rawData,
    })
    .from(normalizedWorkOrders)
    .where(
      and(
        eq(normalizedWorkOrders.shopId, shopId),
        inArray(normalizedWorkOrders.status, [...TERMINAL_STATUSES]),
        // NOTE: `closeDate` is a raw sql`` expression, so drizzle has no
        // column encoder for the right-hand side — a JS Date param would
        // reach postgres-js unserialized and throw ERR_INVALID_ARG_TYPE.
        // Bind an ISO string and cast explicitly instead (see
        // buildCloseDateSincePredicate + tests/missed-opportunities.smoke.ts).
        buildCloseDateSincePredicate(closeDate, since),
        sql`(${normalizedWorkOrders.softDelete}->>'isDeleted')::boolean IS DISTINCT FROM true`,
        sql`${normalizedWorkOrders.isInternal} = false`,
      ),
    )
    .orderBy(desc(closeDate))
    .limit(MAX_ROS_PER_RUN + 1);
  finishStage("closedRoQueryMs", stageStartedAt);

  const truncated = wos.length > MAX_ROS_PER_RUN;
  const scoped = truncated ? wos.slice(0, MAX_ROS_PER_RUN) : wos;

  // Older Protractor normalized rows used the invoice GUID as
  // workOrderNumber because terminal invoice payloads often send
  // InvoiceNumber=0. Resolve only UUID-looking values through the bounded
  // provider cache so existing history displays the readable RO number now;
  // fail open to the canonical value for other providers or cache trouble.
  const opaqueRoNumbers = scoped
    .map((wo) => String(wo.workOrderNumber || ""))
    .filter((value) => UUID_RE.test(value));
  let displayRoNumbers: Record<string, string> = {};
  stageStartedAt = Date.now();
  if (opaqueRoNumbers.length > 0) {
    try {
      const remainingMs = providerCacheBudgetRemainingMs;
      const lookup = await withinProviderCacheBudget(
        () =>
          findDisplayRoNumbersByIds(shopId, opaqueRoNumbers, {
            maxTimeMS: remainingMs,
          }),
        {},
        remainingMs,
      );
      displayRoNumbers = lookup.value;
      console.log(`[MissedOppsTiming] ${JSON.stringify({
        shopId,
        windowDays,
        providerCacheLookup: "display_ro_numbers",
        ids: opaqueRoNumbers.length,
        elapsedMs: Date.now() - stageStartedAt,
        timedOut: lookup.timedOut,
        rows: Object.keys(lookup.value).length,
      })}`);
    } catch (err: any) {
      console.warn(
        `[MissedOpps] Shop ${shopId}: display RO-number lookup failed: ${err?.message || err}`,
      );
    }
  }
  const displayLookupMs = Date.now() - stageStartedAt;
  providerCacheEnrichmentMs += displayLookupMs;
  providerCacheBudgetRemainingMs = Math.max(
    0,
    providerCacheBudgetRemainingMs - displayLookupMs,
  );

  // Service jobs (all dispositions, including deferred/declined) for the
  // scoped ROs, one batched query.
  const titlesByWo = new Map<string, string[]>();
  const ticketJobsByWo = new Map<string, MissedOpportunityTicketJob[]>();
  stageStartedAt = Date.now();
  if (scoped.length > 0) {
    const jobs = await pg
      .select({
        id: normalizedServiceJobs.id,
        workOrderId: normalizedServiceJobs.workOrderId,
        jobNumber: normalizedServiceJobs.jobNumber,
        title: normalizedServiceJobs.title,
        status: normalizedServiceJobs.status,
        total: normalizedServiceJobs.total,
        customFields: normalizedServiceJobs.customFields,
        sequence: normalizedServiceJobs.sequence,
        provenance: normalizedServiceJobs.provenance,
      })
      .from(normalizedServiceJobs)
      .where(
        and(
          eq(normalizedServiceJobs.shopId, shopId),
          inArray(
            normalizedServiceJobs.workOrderId,
            scoped.map((w) => w.id),
          ),
          sql`(${normalizedServiceJobs.softDelete}->>'isDeleted')::boolean IS DISTINCT FROM true`,
        ),
      )
      .orderBy(
        asc(normalizedServiceJobs.workOrderId),
        asc(normalizedServiceJobs.sequence),
        asc(normalizedServiceJobs.id),
      );

    // A historical normalized Protractor total of zero is ambiguous because
    // old ingestion defaulted missing prices to zero. Recover real package
    // evidence from cached snapshots first, then non-zero normalized line
    // prices. This remains bounded to the already-scoped jobs and never calls
    // Protractor.
    const linePricesByJob = new Map<string, string[]>();
    if (jobs.length > 0) {
      const lineItems = await pg
        .select({
          serviceJobId: normalizedLineItems.serviceJobId,
          extendedPrice: normalizedLineItems.extendedPrice,
        })
        .from(normalizedLineItems)
        .where(
          and(
            eq(normalizedLineItems.shopId, shopId),
            inArray(
              normalizedLineItems.serviceJobId,
              jobs.map((job) => job.id),
            ),
            sql`(${normalizedLineItems.softDelete}->>'isDeleted')::boolean IS DISTINCT FROM true`,
          ),
        );
      for (const line of lineItems) {
        const amount = normalizeTicketJobAmount(line.extendedPrice);
        if (amount == null) continue;
        linePricesByJob.set(line.serviceJobId, [
          ...(linePricesByJob.get(line.serviceJobId) || []),
          amount,
        ]);
      }
    }

    const sourceRefs = scoped
      .filter((wo) => provenanceSourceSystem(wo.provenance) === "protractor")
      .map((wo) => protractorSourceIdsByType(wo.provenance));
    const sourceIds = Array.from(new Set(sourceRefs.flatMap((ids) => ids.all)));
    const workOrderIds = Array.from(
      new Set(sourceRefs.flatMap((ids) => ids.workOrderIds)),
    );
    const invoiceIds = Array.from(
      new Set(sourceRefs.flatMap((ids) => ids.invoiceIds)),
    );
    let cachedWorkOrders: ProtractorWorkOrderCacheDoc[] = [];
    let cachedInvoices: ProtractorInvoiceSnapshotDoc[] = [];
    let rawInvoiceCache: ProtractorInvoiceCacheDoc[] = [];
    if (sourceIds.length > 0) {
      const providerStartedAt = Date.now();
      const lookup = async <T>(
        name: string,
        ids: number,
        work: (maxTimeMS: number) => Promise<T[]>,
      ): Promise<T[]> => {
        const lookupStartedAt = Date.now();
        try {
          const remainingMs = providerCacheBudgetRemainingMs;
          const result = await withinProviderCacheBudget(
            () => work(remainingMs),
            [],
            remainingMs,
          );
          console.log(`[MissedOppsTiming] ${JSON.stringify({
            shopId,
            windowDays,
            providerCacheLookup: name,
            ids,
            elapsedMs: Date.now() - lookupStartedAt,
            timedOut: result.timedOut,
            rows: result.value.length,
          })}`);
          return result.value;
        } catch (err: any) {
          console.warn(
            `[MissedOpps] Shop ${shopId}: ${name} lookup failed: ${err?.message || err}`,
          );
          return [];
        }
      };
      [cachedWorkOrders, cachedInvoices, rawInvoiceCache] = await Promise.all([
        lookup(
          "work_orders",
          workOrderIds.length,
          (maxTimeMS) =>
            findCachedWorkOrdersByIds(shopId, workOrderIds, { maxTimeMS }),
        ),
        lookup(
          "invoice_snapshots",
          invoiceIds.length,
          (maxTimeMS) =>
            findCachedInvoiceSnapshotsByIds(shopId, invoiceIds, { maxTimeMS }),
        ),
        lookup(
          "raw_invoice_cache",
          invoiceIds.length,
          (maxTimeMS) =>
            findInvoiceCacheEntriesByIds(shopId, invoiceIds, { maxTimeMS }),
        ),
      ]);
      providerCacheEnrichmentMs += Date.now() - providerStartedAt;
    }
    const cachedBySourceId = new Map(
      cachedWorkOrders.map((doc) => [String(doc.workOrderId), doc]),
    );
    const invoiceBySourceId = new Map(
      cachedInvoices.map((doc) => [String(doc.invoiceId), doc]),
    );
    const rawInvoiceBySourceId = new Map(
      rawInvoiceCache.map((doc) => [String(doc.invoiceId), doc]),
    );
    const cachedPackagesByJobId = new Map<string, any>();
    for (const wo of scoped) {
      if (provenanceSourceSystem(wo.provenance) !== "protractor") continue;
      const woJobs = jobs.filter((job) => job.workOrderId === wo.id);
      const cached = protractorWorkOrderSourceIds(wo.provenance)
        .map((id) => cachedBySourceId.get(id))
        .find(Boolean);
      const cachedInvoice = protractorWorkOrderSourceIds(wo.provenance)
        .map((id) => invoiceBySourceId.get(id))
        .find(Boolean);
      const rawInvoice = protractorWorkOrderSourceIds(wo.provenance)
        .map((id) => rawInvoiceBySourceId.get(id))
        .find(Boolean);
      const packages = firstProtractorPackages(
        (wo.rawData as any)?.rawPayload,
        wo.rawData,
        rawInvoice?.invoice,
        rawInvoice,
        cachedInvoice?.rawPayload,
        cachedInvoice,
        cachedInvoice?.servicePackages
          ? { ServicePackages: cachedInvoice.servicePackages }
          : null,
        cached?.rawPayload,
        cached,
        cached?.servicePackages
          ? { ServicePackages: cached.servicePackages }
          : null,
      );
      const matches = matchNormalizedServiceJobsToCachedProtractorPackages(
        woJobs,
        packages,
      );
      for (const [job, servicePackage] of matches) {
        cachedPackagesByJobId.set(job.id, servicePackage);
      }
    }

    for (const j of jobs) {
      const list = titlesByWo.get(j.workOrderId) || [];
      if (j.title) list.push(j.title);
      titlesByWo.set(j.workOrderId, list);
      const sourceSystem = provenanceSourceSystem(j.provenance);
      const cachedPackage =
        sourceSystem === "protractor"
          ? cachedPackagesByJobId.get(j.id)
          : undefined;
      const cachedTotal =
        cachedPackage != null
          ? normalizeTicketJobAmount(
              getRecordedProtractorPackageTotal(cachedPackage),
            )
          : null;
      const normalizedTotal = normalizeTicketJobAmount(j.total);
      const normalizedLinePrices = linePricesByJob.get(j.id) || [];
      const tekmetricRecordedPrice =
        sourceSystem === "tekmetric" &&
        (j.customFields as any)?.recordedPriceAvailable !== true
          ? null
          : normalizedTotal;
      const totalPrice =
        sourceSystem === "protractor"
          ? resolveProtractorRecordedAmount({
              cachedPackageTotal: cachedTotal,
              normalizedLinePrices,
              normalizedJobTotal: normalizedTotal,
            })
          : tekmetricRecordedPrice;
      const recordedStatus =
        cachedPackage != null
          ? resolveCachedProtractorPackageStatus(cachedPackage, j.status || null)
          : j.status || null;
      const ticketJobs = ticketJobsByWo.get(j.workOrderId) || [];
      ticketJobs.push({
        title: j.title,
        recordedStatus,
        displayGroup: classifyTicketJobStatus(recordedStatus),
        totalPrice,
      });
      ticketJobsByWo.set(j.workOrderId, ticketJobs);
    }
  }
  timings.jobLineEnrichmentMs = Math.max(
    0,
    Date.now() - stageStartedAt - providerCacheEnrichmentMs,
  );
  timings.providerCacheEnrichmentMs = providerCacheEnrichmentMs;

  // Batched cached-plan lookup for all unique VINs (newest RO's odometer as
  // the mileage hint). Cache-only; misses skip the RO.
  const vinMileage = new Map<string, number | null>();
  for (const wo of scoped) {
    const vin = extractVin(wo.vehicle);
    if (!vin || vinMileage.has(vin)) continue;
    const odo = wo.odometerOut ?? wo.odometerIn ?? null;
    vinMileage.set(vin, typeof odo === "number" && odo > 0 ? odo : null);
  }
  const planByVin = new Map<string, ReturnType<typeof planItemsFromBuckets> | null>();
  const vins = Array.from(vinMileage.keys());
  stageStartedAt = Date.now();
  try {
    const plans = await findCachedPlansForVehicles(
      shopId,
      vins.map((vin) => ({ vin, mileage: vinMileage.get(vin) ?? null })),
    );
    for (const vin of vins) {
      const buckets = plans.get(vin)?.plan?.buckets;
      planByVin.set(vin, buckets ? planItemsFromBuckets(buckets) : null);
    }
  } catch (err: any) {
    console.warn(
      `[MissedOpps] Shop ${shopId}: batched plan lookup failed: ${err?.message || err}`,
    );
    for (const vin of vins) planByVin.set(vin, null);
  }
  finishStage("planCacheLoadingMs", stageStartedAt);

  stageStartedAt = Date.now();
  const rows: MissedOpportunityRo[] = scoped.map((wo) => {
    const vin = extractVin(wo.vehicle);
    const vehicleLabel = vehicleLabelFrom(wo.vehicle);
    const titles = titlesByWo.get(wo.id) || [];
    const ticketJobs = ticketJobsByWo.get(wo.id) || [];
    const base = {
      workOrderId: wo.id,
      workOrderNumber:
        displayRoNumbers[String(wo.workOrderNumber || "")] ||
        String(wo.workOrderNumber || ""),
      closedDate: wo.closedAt ? new Date(wo.closedAt).toISOString() : null,
      vin,
      vehicle: vehicleLabel,
      advisorName: wo.serviceAdvisorName || null,
      lineTitleCount: titles.length,
      ticketJobs,
      recommendations: [],
    };
    if (!vin) {
      return { ...base, evaluated: false, skipReason: "No VIN on the repair order", missedItems: [] };
    }
    const planItems = planByVin.get(vin) ?? null;
    if (!planItems) {
      return { ...base, evaluated: false, skipReason: "No cached VHI plan for this vehicle", missedItems: [] };
    }
    if (titles.length === 0) {
      return { ...base, evaluated: false, skipReason: "No service jobs on the repair order", missedItems: [] };
    }
    const recommendations = evaluateMissedOpportunityRecommendations(
      ticketJobs,
      planItems,
    );
    const missedItems = missedItemsFromRecommendations(recommendations);
    return {
      ...base,
      evaluated: true,
      skipReason: null,
      missedItems,
      recommendations,
    };
  });

  const summary = summarizeMissedOpportunities(rows);
  const report = {
    reportVersion: MISSED_OPPORTUNITY_REPORT_VERSION,
    shopId,
    windowDays,
    generatedAt: new Date().toISOString(),
    summary,
    rows: rows.filter((r) => r.evaluated && r.recommendations.length > 0),
    notEvaluated: rows
      .filter((r) => !r.evaluated)
      .map(({ workOrderId, workOrderNumber, closedDate, vin, vehicle, skipReason }) => ({
        workOrderId,
        workOrderNumber,
        closedDate,
        vin,
        vehicle,
        skipReason,
      })),
    truncated,
  };
  finishStage("evaluationMs", stageStartedAt);
  console.log(`[MissedOppsTiming] ${JSON.stringify({
    shopId,
    windowDays,
    scopedRos: scoped.length,
    uniqueVins: vins.length,
    ...timings,
    totalComputeMs: Date.now() - startedAt,
  })}`);
  return report;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Task #1184 — list the (VIN, mileage) pairs the Missed Opportunities report
 * will evaluate for a (shop, window): unique VINs from terminal ROs in the
 * window, newest close first, with the newest RO's odometer as the mileage
 * hint. Used by the plan pre-warm cron so it warms exactly the vehicles the
 * report reads, in the same priority order the report caps at
 * MAX_ROS_PER_RUN. PG-only; touches no upstream API.
 */
export async function listReportWindowVehicles(
  shopId: number,
  windowDays: MissedOppWindow,
  limit: number = MAX_ROS_PER_RUN,
): Promise<Array<{ vin: string; mileage: number | null }>> {
  const pg = getPg();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const closeDate = sql<Date | null>`coalesce(${normalizedWorkOrders.closedDate}, ${normalizedWorkOrders.completedDate})`;
  const wos = await pg
    .select({
      vehicle: normalizedWorkOrders.vehicle,
      odometerOut: normalizedWorkOrders.odometerOut,
      odometerIn: normalizedWorkOrders.odometerIn,
    })
    .from(normalizedWorkOrders)
    .where(
      and(
        eq(normalizedWorkOrders.shopId, shopId),
        inArray(normalizedWorkOrders.status, [...TERMINAL_STATUSES]),
        buildCloseDateSincePredicate(closeDate, since),
        sql`(${normalizedWorkOrders.softDelete}->>'isDeleted')::boolean IS DISTINCT FROM true`,
        sql`${normalizedWorkOrders.isInternal} = false`,
      ),
    )
    .orderBy(desc(closeDate))
    .limit(Math.max(1, limit));

  const out: Array<{ vin: string; mileage: number | null }> = [];
  const seen = new Set<string>();
  for (const wo of wos) {
    const vin = extractVin(wo.vehicle);
    if (!vin || seen.has(vin)) continue;
    seen.add(vin);
    const odo = wo.odometerOut ?? wo.odometerIn ?? null;
    out.push({ vin, mileage: typeof odo === "number" && odo > 0 ? odo : null });
  }
  return out;
}
function extractVin(vehicle: unknown): string | null {
  const vin = (vehicle as any)?.vin;
  if (typeof vin !== "string") return null;
  const up = vin.trim().toUpperCase();
  return up.length === 17 ? up : null;
}

function vehicleLabelFrom(vehicle: unknown): string | null {
  const v = vehicle as any;
  if (!v) return null;
  const bits = [v.year, v.make, v.model].filter(Boolean);
  return bits.length > 0 ? bits.join(" ") : null;
}

function provenanceSourceSystem(value: unknown): string | null {
  const source = (value as any)?.sourceSystem;
  return typeof source === "string" ? source.toLowerCase() : null;
}

function protractorWorkOrderSourceIds(value: unknown): string[] {
  return protractorSourceIdsByType(value).all;
}

function firstProtractorPackages(...sources: unknown[]): any[] {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const packages = extractProtractorServicePackages(source);
    if (packages.length > 0) return packages;
  }
  return [];
}
