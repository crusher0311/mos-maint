/**
 * Tekmetric Full-Page Backfill Worker
 *
 * The regular date-window chunker (`app/api/cron/tekmetric-backfill/route.ts`)
 * walks Tekmetric's `/repair-orders` endpoint backwards in 90-day windows
 * keyed by `updatedDate`. That works for organic shops whose RO updatedDates
 * are spread across the full history range, but it FALSELY marks complete
 * for shops whose history was bulk-migrated into Tekmetric in the last few
 * weeks: every single RO has a recent `updatedDate`, so 18 windows in a row
 * return zero ROs and the chunker concludes the shop is done with only a
 * tiny fraction of its actual history indexed (Casey Palatine: 4k of 270k,
 * Casey Arlington Heights: 3.5k of 178k, Casey Streamwood: 24k of 212k).
 *
 * This module is the fix. It paginates `/repair-orders?shop=X&page=N&size=100`
 * with NO `updatedDateStart`/`updatedDateEnd` filter and `sort=id,asc` so the
 * page index is stable even as new ROs land. For each RO it builds the same
 * `job_index` document the chunker writes (so the dashboard and VHI lookups
 * see consistent data) and feeds the batch to `createIngestionService`'s
 * normalization pipeline (so `cached_plans` and other normalized collections
 * populate identically to a chunker-driven backfill).
 *
 * Resumable: per-call processes up to MAX_PAGES_PER_RUN pages then persists
 * `fullPageNextPage` on the same `tekmetric_backfill_progress` row used by
 * the chunker. The cron route invokes this until `complete:true` is returned.
 *
 * Activation: a row in `tekmetric_backfill_progress` with `fullPageMode: true`
 * is the trigger. The chunker has an early-return guard that defers to this
 * worker for any such row, so the two paths never race writes.
 */

import crypto from "crypto";
import { createIngestionService } from "@/lib/integrations/core/normalized-ingestion";
import {
  tekmetricRequest as centralTekmetricRequest,
  runWithTekmetric429Tracking,
} from "@/lib/integrations/tekmetric/client";
import {
  getCachedVehicle,
  cacheVehicle,
  getCachedCustomer,
  cacheCustomer,
  getCachedJobs,
  cacheJobs,
} from "@/lib/integrations/tekmetric/incremental-sync";

// Each cron tick processes up to this many pages of 100 ROs each. Empirically
// each page costs ~20-30s of wall-clock at 8 RPS once vehicle/customer/jobs
// fetches are factored in (the shared Tekmetric budget gets fragmented across
// dependent calls). The SOFT_DEADLINE_MS guard below bails cleanly mid-chunk
// before Render kills the route, so a higher MAX is safe — it just lets one
// shop drain longer per tick rather than spreading thin across many shops.
// Bumped 10 -> 30 in tandem with the 5 -> 8 RPS cap bump so HEART/Honest Tom
// drains finish in weeks instead of months.
const MAX_PAGES_PER_RUN = 30;
const PAGE_SIZE = 100;
// Bail cleanly (with a progress write) before the route gets killed by
// Render's request timeout. 240s leaves ~60s headroom under the 300s limit.
const SOFT_DEADLINE_MS = 240 * 1000;

type TekmetricVehicle = {
  id: number;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  engine?: string;
  mileageIn?: number;
  mileageOut?: number;
};

type TekmetricCustomer = {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
};

type TekmetricJob = {
  id: number;
  repairOrderId: number;
  name: string;
  laborTotal?: number;
  partsTotal?: number;
  subtotal?: number;
  laborHours?: number;
  labor?: any[];
  parts?: Array<{
    id: number;
    partNumber?: string;
    name?: string;
    description?: string;
    quantity?: number;
    cost?: number;
    retailCost?: number;
    brand?: string;
  }>;
  createdDate?: string;
  updatedDate?: string;
};

type TekmetricRepairOrder = {
  id: number;
  repairOrderNumber: number;
  shopId: number;
  customerId?: number;
  vehicleId?: number;
  repairOrderStatus?: { id: number; code: string; name: string };
  milesIn?: number;
  milesOut?: number;
  postedDate?: string;
  completedDate?: string;
  createdDate?: string;
  updatedDate?: string;
};

async function tekmetricRequest<T>(
  endpoint: string,
  shopId?: number,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    // Backfill is background work — yield rate-limit slots to interactive
    // VHI/dashboard requests so techs aren't waiting behind a 30-page chunk.
    const data = await centralTekmetricRequest<T>(
      endpoint,
      {},
      shopId,
      false,
      false,
      'background',
    );
    return { ok: true, data };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

function computeContentHash(entry: any): string {
  const hashContent = {
    workOrderId: entry.workOrderId,
    servicePackageId: entry.servicePackageId,
    vehicle: entry.vehicle,
    jobName: entry.jobName,
    lines: entry.lines,
    totalAmount: entry.totalAmount,
    laborAmount: entry.laborAmount,
    partsAmount: entry.partsAmount,
    laborHours: entry.laborHours,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(hashContent))
    .digest("hex")
    .slice(0, 16);
}

export interface FullPageBackfillResult {
  ok: boolean;
  complete: boolean;
  pagesProcessed: number;
  startPage: number;
  endPage: number;
  totalPages: number;
  rosFetched: number;
  jobsIndexed: number;
  jobsSkipped: number;
  normalizedCount: number;
  message: string;
  error?: string;
}

/**
 * Run a single full-page backfill chunk for one shop.
 *
 * Returns when MAX_PAGES_PER_RUN pages are processed OR Tekmetric reports
 * `page+1 >= totalPages` (the latter sets `complete:true` and clears the
 * fullPageMode flag so this shop drops out of the worker queue).
 */
export async function runFullPageBackfillChunk(
  db: any,
  shopId: number,
  tekmetricShopId: number,
): Promise<FullPageBackfillResult> {
  return runWithTekmetric429Tracking(async () => {
    const startedAt = Date.now();
    const progress = await db
      .collection("tekmetric_backfill_progress")
      .findOne({ shopId });
    const startPage: number =
      typeof progress?.fullPageNextPage === "number"
        ? progress.fullPageNextPage
        : 0;

    const shop = await db.collection("shops").findOne({ shopId });
    const enterpriseId = shop?.enterpriseId;
    const ingestionService = createIngestionService(
      db,
      "tekmetric",
      shopId,
      enterpriseId,
      {
        syncRunId: `tekmetric-fullpage-${Date.now()}`,
        createAuditLog: false,
        dualWriteToJobIndex: true,
        dualWriteToRepairPatterns: true,
      },
    );

    let page = startPage;
    let pagesProcessed = 0;
    let totalPages = 0;
    let rosFetched = 0;
    let jobsIndexed = 0;
    let jobsSkipped = 0;
    const rosForNormalized: any[] = [];

    // Per-run caches: vehicles and customers are looked up many times across
    // the same shop. Mongo cache (getCachedVehicle/getCachedCustomer) is the
    // cross-run fallback; this in-memory map saves the Mongo roundtrip
    // within a single run.
    const vehicleCache = new Map<number, TekmetricVehicle>();
    const customerCache = new Map<number, TekmetricCustomer>();

    console.log(
      `[Tekmetric Full-Page Backfill] Shop ${shopId}: starting at page ${startPage}, max ${MAX_PAGES_PER_RUN} pages this run`,
    );

    let lastError: string | null = null;
    let reachedEnd = false;

    while (pagesProcessed < MAX_PAGES_PER_RUN) {
      const queryParams = new URLSearchParams({
        shop: tekmetricShopId.toString(),
        page: page.toString(),
        size: PAGE_SIZE.toString(),
        sort: "id",
        sortDirection: "ASC",
      });

      const rosResult = await tekmetricRequest<{
        content: TekmetricRepairOrder[];
        totalPages: number;
        totalElements?: number;
      }>(`/repair-orders?${queryParams}`, shopId);

      if (!rosResult.ok || !rosResult.data) {
        lastError = rosResult.error || "RO list call failed";
        console.error(
          `[Tekmetric Full-Page Backfill] Shop ${shopId} page ${page} error: ${lastError}`,
        );
        break;
      }

      totalPages = rosResult.data.totalPages || 0;
      const ros = rosResult.data.content || [];

      console.log(
        `[Tekmetric Full-Page Backfill] Shop ${shopId} page ${page + 1}/${totalPages}: ${ros.length} ROs`,
      );

      if (ros.length === 0) {
        // Sorted-ASC pagination past the last page. Done.
        reachedEnd = true;
        page++;
        pagesProcessed++;
        break;
      }

      rosFetched += ros.length;

      for (const ro of ros) {
        try {
          const statusCode =
            ro.repairOrderStatus?.code?.toUpperCase() || "";
          // Match the chunker's filter: only terminal ROs get indexed. Open
          // ROs change too often to be useful for service-history lookups.
          if (
            !["POSTED", "INVOICED", "COMPLETED"].includes(statusCode)
          ) {
            continue;
          }

          let vehicle: TekmetricVehicle | null = null;
          if (ro.vehicleId) {
            if (vehicleCache.has(ro.vehicleId)) {
              vehicle = vehicleCache.get(ro.vehicleId)!;
            } else {
              const cached = await getCachedVehicle(
                db,
                ro.vehicleId,
              ).catch(() => null);
              if (cached) {
                vehicle = cached as TekmetricVehicle;
                vehicleCache.set(ro.vehicleId, vehicle);
              } else {
                const vehResult = await tekmetricRequest<TekmetricVehicle>(
                  `/vehicles/${ro.vehicleId}`,
                  shopId,
                );
                if (vehResult.ok && vehResult.data) {
                  vehicle = vehResult.data;
                  vehicleCache.set(ro.vehicleId, vehicle);
                  await cacheVehicle(db, ro.vehicleId, vehResult.data as any).catch(
                    () => {},
                  );
                }
              }
            }
          }

          let customer: TekmetricCustomer | null = null;
          if (ro.customerId) {
            if (customerCache.has(ro.customerId)) {
              customer = customerCache.get(ro.customerId)!;
            } else {
              const cached = await getCachedCustomer(
                db,
                ro.customerId,
              ).catch(() => null);
              if (cached) {
                customer = cached as TekmetricCustomer;
                customerCache.set(ro.customerId, customer);
              } else {
                const custResult =
                  await tekmetricRequest<TekmetricCustomer>(
                    `/customers/${ro.customerId}`,
                    shopId,
                  );
                if (custResult.ok && custResult.data) {
                  customer = custResult.data;
                  customerCache.set(ro.customerId, customer);
                  await cacheCustomer(
                    db,
                    ro.customerId,
                    custResult.data as any,
                  ).catch(() => {});
                }
              }
            }
          }

          // Jobs lookup: same priority order as the chunker. The full-page
          // path can't use the bulk shop-window pre-pass (that's keyed by
          // updatedDate), so we rely on the per-RO cache + Mongo cache +
          // tekmetric_work_orders fallback.
          let jobs: TekmetricJob[] = [];
          const cachedJobs = await getCachedJobs(db, ro.id).catch(
            () => null,
          );
          if (cachedJobs) {
            jobs = cachedJobs as TekmetricJob[];
          } else {
            const cachedWO = await db
              .collection("tekmetric_work_orders")
              .findOne(
                {
                  shopId: { $in: [String(shopId), Number(shopId)] },
                  workOrderId: String(ro.id),
                },
                { projection: { "data.jobs": 1 } },
              )
              .catch(() => null);
            const woJobs = cachedWO?.data?.jobs;
            if (Array.isArray(woJobs) && woJobs.length > 0) {
              jobs = woJobs as TekmetricJob[];
              await cacheJobs(db, ro.id, jobs).catch(() => {});
            } else {
              const jobsResult = await tekmetricRequest<{
                content: TekmetricJob[];
              }>(
                `/jobs?shop=${tekmetricShopId}&repairOrderId=${ro.id}`,
                shopId,
              );
              if (!jobsResult.ok) {
                console.warn(
                  `[Tekmetric Full-Page Backfill] Shop ${shopId} RO ${ro.id} /jobs failed: ${jobsResult.error}`,
                );
                continue;
              }
              jobs = jobsResult.data?.content || [];
              await cacheJobs(db, ro.id, jobs).catch(() => {});
            }
          }

          if (jobs.length === 0) continue;

          for (const job of jobs) {
            const laborAmountDollars = (job.laborTotal || 0) / 100;
            const partsAmountDollars = (job.partsTotal || 0) / 100;

            const roMileage =
              (typeof ro.milesOut === "number" && ro.milesOut > 0
                ? ro.milesOut
                : null) ??
              (typeof ro.milesIn === "number" && ro.milesIn > 0
                ? ro.milesIn
                : null) ??
              (vehicle &&
              typeof (vehicle as any).mileageOut === "number" &&
              (vehicle as any).mileageOut > 0
                ? (vehicle as any).mileageOut
                : null) ??
              (vehicle &&
              typeof (vehicle as any).mileageIn === "number" &&
              (vehicle as any).mileageIn > 0
                ? (vehicle as any).mileageIn
                : null) ??
              null;

            const entry: any = {
              shopId,
              sourceSystem: "tekmetric",
              workOrderId: String(ro.id),
              workOrderNumber: ro.repairOrderNumber,
              servicePackageId: String(job.id),
              jobName: job.name,
              closedAt:
                ro.postedDate || ro.completedDate || ro.updatedDate,
              mileage: roMileage,
              vehicle: vehicle
                ? {
                    vin: vehicle.vin,
                    year: vehicle.year,
                    make: vehicle.make,
                    model: vehicle.model,
                    engine: vehicle.engine,
                    mileage: roMileage,
                  }
                : null,
              customer: customer
                ? {
                    name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
                    email: customer.email,
                    phone: customer.phone,
                  }
                : null,
              totalAmount: (job.subtotal || 0) / 100,
              laborAmount: laborAmountDollars,
              partsAmount: partsAmountDollars,
              laborHours: job.laborHours || 0,
              lines: [] as any[],
              indexedAt: new Date(),
            };

            if (job.parts?.length) {
              for (const part of job.parts) {
                entry.lines.push({
                  lineType: "part",
                  partNumber: part.partNumber,
                  description: part.name,
                  manufacturer: part.brand,
                  quantity: part.quantity || 1,
                  unitPrice: (part.retailCost || 0) / 100,
                  extendedPrice:
                    ((part.quantity || 1) * (part.retailCost || 0)) / 100,
                });
              }
            }

            const contentHash = computeContentHash(entry);
            const filter = {
              shopId,
              workOrderId: String(ro.id),
              servicePackageId: String(job.id),
            };
            const existing = await db
              .collection("job_index")
              .findOne(filter);
            if (existing && existing.contentHash === contentHash) {
              jobsSkipped++;
              continue;
            }
            await db
              .collection("job_index")
              .updateOne(
                filter,
                { $set: { ...entry, contentHash } },
                { upsert: true },
              );
            jobsIndexed++;
          }

          rosForNormalized.push({
            id: ro.id,
            repairOrderNumber: ro.repairOrderNumber,
            repairOrderStatus:
              ro.repairOrderStatus?.code || ro.repairOrderStatus,
            postedDate: ro.postedDate,
            completedDate: ro.completedDate,
            createdDate: ro.createdDate,
            updatedDate: ro.updatedDate,
            milesIn: ro.milesIn,
            milesOut: ro.milesOut,
            laborSubtotal: jobs.reduce(
              (sum, j) => sum + (j.laborTotal || 0),
              0,
            ),
            partsSubtotal: jobs.reduce(
              (sum, j) => sum + (j.partsTotal || 0),
              0,
            ),
            total: jobs.reduce((sum, j) => sum + (j.subtotal || 0), 0),
            vehicle: vehicle,
            customer: customer,
            jobs: jobs.map((j) => ({
              id: j.id,
              name: j.name,
              laborTotal: (j.laborTotal || 0) / 100,
              partsTotal: (j.partsTotal || 0) / 100,
              total: (j.subtotal || 0) / 100,
              laborHours: j.laborHours || 0,
              labor: j.labor,
              parts: j.parts,
            })),
            inspections: [],
            inspectionUrl: (ro as any).inspectionUrl || null,
            inspectionShareDate:
              (ro as any).inspectionShareDate || null,
            rawPayload: {
              repairOrder: ro,
              vehicle,
              customer,
              jobs,
            },
          });
        } catch (roErr: any) {
          // Per-RO safety net mirrors the chunker: never let one bad RO
          // crash the whole page.
          console.warn(
            `[Tekmetric Full-Page Backfill] Shop ${shopId} RO ${ro.id} threw: ${(roErr?.message || String(roErr)).slice(0, 200)}`,
          );
        }
      }

      page++;
      pagesProcessed++;

      // Persist progress after EVERY page so a mid-chunk timeout only costs
      // one page of work. Without this, a request killed by Render's 300s
      // limit (or the cron wrapper's 5min timeout) loses the whole batch
      // and the next tick restarts from `fullPageNextPage`'s last value —
      // which, on a fresh flag, is still 0. That's how shop 82 spent 30
      // minutes re-indexing the same first 7 pages.
      try {
        await db
          .collection("tekmetric_backfill_progress")
          .updateOne(
            { shopId },
            {
              $set: {
                fullPageNextPage: page,
                fullPageTotalPages: totalPages,
                lastFullPageRunAt: new Date(),
              },
            },
          );
      } catch (writeErr: any) {
        console.warn(
          `[Tekmetric Full-Page Backfill] Shop ${shopId} progress write failed at page ${page}: ${writeErr?.message || writeErr}`,
        );
      }

      if (totalPages > 0 && page >= totalPages) {
        reachedEnd = true;
        break;
      }

      // Soft deadline: stop adding pages so we have time to flush the
      // normalized batch + write the final progress doc before the route
      // is killed.
      if (Date.now() - startedAt >= SOFT_DEADLINE_MS) {
        console.log(
          `[Tekmetric Full-Page Backfill] Shop ${shopId}: soft deadline hit after ${pagesProcessed} pages, deferring rest to next tick`,
        );
        break;
      }
    }

    // Normalize the batch (populates cached_plans, work_orders normalized
    // collections, etc). Same call the chunker uses, so the data shape is
    // identical and downstream consumers don't need to know which path
    // produced the row.
    let normalizedCount = 0;
    if (rosForNormalized.length > 0) {
      try {
        const normalizedResult =
          await ingestionService.ingestWorkOrderBatchWithAllEntities(
            rosForNormalized,
          );
        normalizedCount =
          normalizedResult.workOrders.created +
          normalizedResult.workOrders.updated;
      } catch (normErr: any) {
        console.error(
          `[Tekmetric Full-Page Backfill] Shop ${shopId}: normalized ingestion error:`,
          normErr,
        );
      }
    }

    const now = new Date();
    const complete = reachedEnd && !lastError;

    const update: any = {
      $set: {
        fullPageMode: !complete,
        fullPageNextPage: page,
        fullPageTotalPages: totalPages,
        lastRunAt: now,
        lastFullPageRunAt: now,
      },
      $inc: {
        totalJobsIndexed: jobsIndexed,
      },
    };
    if (complete) {
      update.$set.completed = true;
      update.$set.complete = true;
      update.$set.completedAt = now;
      update.$set.needsFullPageReindex = false;
      update.$set.fullPageCompletedAt = now;
      update.$set.lastError = null;
      update.$set.lastErrorAt = null;
    } else if (lastError) {
      update.$set.lastError = `full-page chunk error: ${lastError.slice(0, 400)}`;
      update.$set.lastErrorAt = now;
    } else {
      update.$set.lastError = null;
      update.$set.lastErrorAt = null;
    }

    await db
      .collection("tekmetric_backfill_progress")
      .updateOne({ shopId }, update);

    if (complete) {
      await db
        .collection("shops")
        .updateOne(
          { shopId },
          {
            $set: {
              tekmetricBackfillComplete: true,
              tekmetricBackfillCompletedAt: now,
            },
          },
        );
    }

    const durationMs = Date.now() - startedAt;
    console.log(
      `[Tekmetric Full-Page Backfill] Shop ${shopId}: pages ${startPage}..${page - 1} of ${totalPages || "?"}, ${rosFetched} ROs, ${jobsIndexed} jobs indexed, ${jobsSkipped} unchanged, ${normalizedCount} normalized, ${durationMs}ms${complete ? " — COMPLETE" : ""}`,
    );

    return {
      ok: !lastError,
      complete,
      pagesProcessed,
      startPage,
      endPage: page - 1,
      totalPages,
      rosFetched,
      jobsIndexed,
      jobsSkipped,
      normalizedCount,
      message: complete
        ? `Full-page reindex complete: ${rosFetched} ROs in this run, ${jobsIndexed} jobs indexed`
        : lastError
          ? `Full-page chunk error after ${pagesProcessed} pages: ${lastError}`
          : `Full-page chunk: pages ${startPage}..${page - 1} of ${totalPages}, ${jobsIndexed} jobs indexed`,
      error: lastError || undefined,
    };
  });
}

/**
 * Probe Tekmetric for `totalElements` (no date filter) so callers can
 * compare against the indexed RO count and detect "low-coverage" shops.
 * Returns null on failure — callers should treat that as "couldn't check"
 * rather than "no ROs available".
 */
export async function probeTekmetricRoCount(
  shopId: number,
  tekmetricShopId: number,
): Promise<number | null> {
  try {
    const result = await tekmetricRequest<{ totalElements?: number }>(
      `/repair-orders?shop=${tekmetricShopId}&page=0&size=1`,
      shopId,
    );
    if (!result.ok || !result.data) return null;
    return typeof result.data.totalElements === "number"
      ? result.data.totalElements
      : null;
  } catch {
    return null;
  }
}

/**
 * Mark a shop for full-page reindex. Clears completion flags so the cron
 * picks it up and the chunker's early-return guard defers to the full-page
 * worker. Idempotent.
 */
export async function flagShopForFullPageReindex(
  db: any,
  shopId: number,
  reason: string,
): Promise<void> {
  const now = new Date();
  await db.collection("tekmetric_backfill_progress").updateOne(
    { shopId },
    {
      $set: {
        shopId,
        fullPageMode: true,
        fullPageNextPage: 0,
        needsFullPageReindex: true,
        fullPageQueuedAt: now,
        fullPageQueueReason: reason.slice(0, 300),
        completed: false,
        complete: false,
        lastError: null,
        lastErrorAt: null,
      },
      $unset: {
        completedAt: "",
        fullPageCompletedAt: "",
      },
      $setOnInsert: {
        startedAt: now,
        logicVersion: 2,
      },
    },
    { upsert: true },
  );
  await db
    .collection("shops")
    .updateOne({ shopId }, { $set: { tekmetricBackfillComplete: false } });
}
