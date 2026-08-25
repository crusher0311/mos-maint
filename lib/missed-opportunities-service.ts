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
 *   3. Run the shared Task #1145 RO-line ↔ VHI matcher per RO. Every
 *      service-job title is passed — declined jobs included, because a
 *      declined item was presented and therefore counts as quoted.
 *
 * Results are cached per (shop, window) in Mongo by the caller (the API
 * route) so page loads serve the cache and recompute at most every
 * REPORT_TTL_MS.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { buildCloseDateSincePredicate } from "@/lib/missed-opportunities-query";
import { getDb as getPg } from "@/lib/db/drizzle";
import {
  normalizedWorkOrders,
  normalizedServiceJobs,
} from "@/lib/db/schema/normalized";
import { findCachedPlanForVehicle } from "@/lib/data/repositories/missed-opportunities";
import {
  planItemsFromBuckets,
  evaluateRoLines,
  summarizeMissedOpportunities,
  type MissedOpportunityReport,
  type MissedOpportunityRo,
  type MissedOppWindow,
} from "@/lib/missed-opportunities";

/** Hard cap on ROs evaluated per run — large shops degrade to "newest N". */
export const MAX_ROS_PER_RUN = 300;
/** Concurrent cached-plan lookups. */
const PLAN_LOOKUP_CONCURRENCY = 4;
/** Serve-from-cache TTL used by the API route. */
export const REPORT_TTL_MS = 30 * 60 * 1000;

/** RO statuses that mean the ticket is closed/terminal. */
const TERMINAL_STATUSES = ["invoiced", "paid", "closed", "archived"] as const;

export async function computeMissedOpportunityReport(
  shopId: number,
  windowDays: MissedOppWindow,
): Promise<MissedOpportunityReport> {
  const pg = getPg();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // Closed ROs in window, newest close first. completed_date fills for
  // providers that never stamp closedDate. This exact 2-arg coalesce
  // expression is served by nwo_shop_close_date_idx
  // (drizzle/0032_task1183_nwo_close_date_idx.sql) — keep the expression
  // in sync with that index or the query degrades to a multi-second
  // shop_id scan on large shops (Task #1183).
  const closeDate = sql<Date | null>`coalesce(${normalizedWorkOrders.closedDate}, ${normalizedWorkOrders.completedDate})`;
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

  const truncated = wos.length > MAX_ROS_PER_RUN;
  const scoped = truncated ? wos.slice(0, MAX_ROS_PER_RUN) : wos;

  // Service jobs (ALL of them — declined included; declined counts as
  // quoted) for the scoped ROs, one batched query.
  const titlesByWo = new Map<string, string[]>();
  if (scoped.length > 0) {
    const jobs = await pg
      .select({
        workOrderId: normalizedServiceJobs.workOrderId,
        title: normalizedServiceJobs.title,
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
      );
    for (const j of jobs) {
      const list = titlesByWo.get(j.workOrderId) || [];
      if (j.title) list.push(j.title);
      titlesByWo.set(j.workOrderId, list);
    }
  }

  // One cached-plan lookup per unique VIN (newest RO's odometer as the
  // mileage hint), bounded concurrency. Cache-only; misses skip the RO.
  const vinMileage = new Map<string, number | null>();
  for (const wo of scoped) {
    const vin = extractVin(wo.vehicle);
    if (!vin || vinMileage.has(vin)) continue;
    const odo = wo.odometerOut ?? wo.odometerIn ?? null;
    vinMileage.set(vin, typeof odo === "number" && odo > 0 ? odo : null);
  }
  const planByVin = new Map<string, ReturnType<typeof planItemsFromBuckets> | null>();
  const vins = Array.from(vinMileage.keys());
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(PLAN_LOOKUP_CONCURRENCY, vins.length) }).map(
      async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= vins.length) return;
          const vin = vins[idx];
          try {
            const plan = await findCachedPlanForVehicle(
              shopId,
              vin,
              vinMileage.get(vin) ?? null,
            );
            const buckets = plan?.plan?.buckets;
            planByVin.set(vin, buckets ? planItemsFromBuckets(buckets) : null);
          } catch (err: any) {
            console.warn(
              `[MissedOpps] Shop ${shopId}: plan lookup failed for ${vin}: ${err?.message || err}`,
            );
            planByVin.set(vin, null);
          }
        }
      },
    ),
  );

  const rows: MissedOpportunityRo[] = scoped.map((wo) => {
    const vin = extractVin(wo.vehicle);
    const vehicleLabel = vehicleLabelFrom(wo.vehicle);
    const titles = titlesByWo.get(wo.id) || [];
    const base = {
      workOrderId: wo.id,
      workOrderNumber: String(wo.workOrderNumber || ""),
      closedDate: wo.closedAt ? new Date(wo.closedAt).toISOString() : null,
      vin,
      vehicle: vehicleLabel,
      advisorName: wo.serviceAdvisorName || null,
      lineTitleCount: titles.length,
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
    const missedItems = evaluateRoLines(titles, planItems);
    return { ...base, evaluated: true, skipReason: null, missedItems };
  });

  const summary = summarizeMissedOpportunities(rows);
  return {
    shopId,
    windowDays,
    generatedAt: new Date().toISOString(),
    summary,
    rows: rows.filter((r) => r.evaluated && r.missedItems.length > 0),
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
