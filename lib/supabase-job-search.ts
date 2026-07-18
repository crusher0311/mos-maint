import { getDb } from "@/lib/db/drizzle";
import { normalizedServiceJobs, normalizedWorkOrders, normalizedLineItems } from "@/lib/db/schema/normalized";
import { eq, and, inArray, ilike, sql, desc, isNull, or, lte } from "drizzle-orm";
import { expandTokenVariants } from "@/lib/job-scoring";

export async function searchSupabaseServiceJobs(
  searchShopIds: number[],
  coreTokens: string[],
  vehicleMake?: string,
  limit: number = 50,
  vehicleModel?: string,
  strictModel: boolean = false,
): Promise<any[]> {
  if (searchShopIds.length === 0) return [];

  // Caller contract: at least one of `coreTokens` or `vehicleMake` must be
  // provided. Returning `[]` for an unbounded query (no tokens AND no make)
  // protects PG from a full-table scan over `normalized_service_jobs`. The
  // dashboard route (`app/api/jobs/search`) explicitly accepts `q` OR `make`,
  // so make-only searches must be preserved here — see task #299.
  if (coreTokens.length === 0 && !vehicleMake) return [];

  try {
    const db = getDb();

    // For each token expand to its singular/plural variants and OR across
    // (title|description|cannedJobName) for every variant. Substring `ilike`
    // already handles "pad" -> donor "pads" by accident (substring match),
    // but the reverse direction ("pads" -> donor "pad") needs the explicit
    // singular form. Variants keeps both arms symmetric with the Mongo fix.
    const tokenConditions = coreTokens.map(token => {
      const variants = expandTokenVariants(token);
      const orParts = variants.flatMap(v => {
        const pattern = `%${v}%`;
        return [
          ilike(normalizedServiceJobs.title, pattern),
          ilike(normalizedServiceJobs.description, pattern),
          ilike(normalizedServiceJobs.cannedJobName, pattern),
        ];
      });
      return or(...orParts);
    });

    // Push make/model into the SQL filter so the per-shop candidate ranking
    // below operates on rows that already match the target vehicle. Previously
    // make/model were filtered in JS *after* the recency cap, so a shop's
    // relevant rows could be discarded before we ever saw them.
    const vehicleConditions: any[] = [];
    if (vehicleMake) {
      vehicleConditions.push(
        sql`lower(${normalizedWorkOrders.vehicle} ->> 'make') LIKE ${`%${vehicleMake.toLowerCase()}%`}`
      );
    }
    if (strictModel && vehicleModel) {
      vehicleConditions.push(
        sql`lower(${normalizedWorkOrders.vehicle} ->> 'model') = ${vehicleModel.toLowerCase()}`
      );
    }

    const conditions = [
      inArray(normalizedServiceJobs.shopId, searchShopIds),
      sql`(${normalizedServiceJobs.softDelete}->>'isDeleted')::boolean = false`,
      ...tokenConditions.filter(Boolean) as any[],
      ...vehicleConditions,
    ];

    // Fair per-shop candidate selection. Previously we pulled the globally
    // most-recently-imported matching rows across ALL enterprise shops and
    // capped that single list — so whichever shop's data was ingested most
    // recently (or is simply the busiest) could fill the entire candidate
    // window and starve every other location before scoring even ran. Instead
    // we rank rows *within each shop* by recency (ROW_NUMBER partitioned by
    // shop) and keep each shop's top slice, so every location gets a fair shot
    // at the ranking step. The final relevance sort happens downstream in the
    // route's scoreJob pass.
    const shopCount = searchShopIds.length;
    const perShopLimit = Math.max(
      6,
      Math.min(limit, Math.ceil((limit * 3) / shopCount))
    );

    const ranked = db
      .select({
        id: normalizedServiceJobs.id,
        shopId: normalizedServiceJobs.shopId,
        workOrderId: normalizedServiceJobs.workOrderId,
        title: normalizedServiceJobs.title,
        description: normalizedServiceJobs.description,
        cannedJobName: normalizedServiceJobs.cannedJobName,
        laborTotal: normalizedServiceJobs.laborTotal,
        partsTotal: normalizedServiceJobs.partsTotal,
        total: normalizedServiceJobs.total,
        laborHoursBilled: normalizedServiceJobs.laborHoursBilled,
        laborHoursActual: normalizedServiceJobs.laborHoursActual,
        provenance: normalizedServiceJobs.provenance,
        createdAt: normalizedServiceJobs.createdAt,
        woNumber: normalizedWorkOrders.workOrderNumber,
        woVehicle: normalizedWorkOrders.vehicle,
        woVehicleId: normalizedWorkOrders.vehicleId,
        woCompletedDate: normalizedWorkOrders.completedDate,
        woClosedDate: normalizedWorkOrders.closedDate,
        rn: sql<number>`row_number() over (partition by ${normalizedServiceJobs.shopId} order by ${normalizedServiceJobs.createdAt} desc)`.as("rn"),
      })
      .from(normalizedServiceJobs)
      .innerJoin(
        normalizedWorkOrders,
        eq(normalizedServiceJobs.workOrderId, normalizedWorkOrders.id)
      )
      .where(and(...conditions))
      .as("ranked");

    const serviceJobs = await db
      .select({
        id: ranked.id,
        shopId: ranked.shopId,
        workOrderId: ranked.workOrderId,
        title: ranked.title,
        description: ranked.description,
        cannedJobName: ranked.cannedJobName,
        laborTotal: ranked.laborTotal,
        partsTotal: ranked.partsTotal,
        total: ranked.total,
        laborHoursBilled: ranked.laborHoursBilled,
        laborHoursActual: ranked.laborHoursActual,
        provenance: ranked.provenance,
        createdAt: ranked.createdAt,
        woNumber: ranked.woNumber,
        woVehicle: ranked.woVehicle,
        woVehicleId: ranked.woVehicleId,
        woCompletedDate: ranked.woCompletedDate,
        woClosedDate: ranked.woClosedDate,
      })
      .from(ranked)
      .where(lte(ranked.rn, perShopLimit))
      // Round-robin across shops (each shop's #1, then #2, ...) so the global
      // safety cap below can never re-introduce single-shop bias; recency
      // breaks ties within a rank.
      .orderBy(ranked.rn, desc(ranked.createdAt))
      .limit(limit * 3);

    const filtered = serviceJobs;

    const lineItemsByJob = new Map<string, any[]>();
    if (filtered.length > 0) {
      const jobIds = filtered.map(sj => sj.id);
      try {
        const lines = await db
          .select({
            serviceJobId: normalizedLineItems.serviceJobId,
            lineType: normalizedLineItems.lineType,
            partDescription: normalizedLineItems.partDescription,
            partNumber: normalizedLineItems.partNumber,
            partManufacturer: normalizedLineItems.partManufacturer,
            quantity: normalizedLineItems.quantity,
            unitCost: normalizedLineItems.unitCost,
            unitPrice: normalizedLineItems.unitPrice,
            extendedPrice: normalizedLineItems.extendedPrice,
            laborHours: normalizedLineItems.laborHours,
          })
          .from(normalizedLineItems)
          .where(inArray(normalizedLineItems.serviceJobId, jobIds));

        for (const line of lines) {
          const existing = lineItemsByJob.get(line.serviceJobId) || [];
          existing.push(line);
          lineItemsByJob.set(line.serviceJobId, existing);
        }
      } catch (lineErr) {
        console.log("[Supabase Job Search] Line items fetch failed (non-blocking):", (lineErr as Error).message);
      }
    }

    return filtered.map(sj => mapServiceJobToCanonicalResult(sj, lineItemsByJob.get(sj.id) || []));
  } catch (err) {
    console.log("[Supabase Job Search] Error:", (err as Error).message);
    return [];
  }
}

/**
 * Pure mapper: turns a raw normalized_service_jobs row (joined with its
 * work order) plus its line items into the canonical job-search result shape
 * the dashboard consumes. Exported for snapshot testing — keep this in sync
 * with `app/api/jobs/search` consumers when the canonical shape evolves.
 */
export function mapServiceJobToCanonicalResult(sj: any, rawLines: any[]) {
  const vehicle = sj.woVehicle as any;
  const prov = sj.provenance as any;
  const totals = {
    laborAmount: parseFloat(String(sj.laborTotal)) || 0,
    partsAmount: parseFloat(String(sj.partsTotal)) || 0,
    totalAmount: parseFloat(String(sj.total)) || 0,
    laborHours: parseFloat(String(sj.laborHoursBilled || sj.laborHoursActual || 0)) || 0,
  };
  return {
    _id: sj.id,
    shopId: sj.shopId,
    vin: vehicle?.vin,
    vehicle: {
      vin: vehicle?.vin,
      year: vehicle?.year,
      make: vehicle?.make,
      model: vehicle?.model,
      engine: vehicle?.engineDescription || vehicle?.engine,
      // Task #880 — pass stored ACES identity through when the normalized
      // ingestion enriched the WO vehicle snapshot, so the job-search spec
      // resolver can score this donor without a live DataOne decode.
      acesVehicleId: vehicle?.acesVehicleId ?? null,
      acesEngineId: vehicle?.acesEngineId ?? null,
      submodelKey: vehicle?.submodelKey ?? null,
    },
    job: {
      title: sj.title,
      description: sj.description,
      name: sj.cannedJobName || sj.title,
      keywords: [],
      totals,
    },
    lines: (rawLines || []).map((li: any) => ({
      lineType: li.lineType,
      description: li.partDescription,
      partNumber: li.partNumber,
      manufacturer: li.partManufacturer,
      quantity: parseFloat(String(li.quantity)) || 1,
      unitPrice: parseFloat(String(li.unitPrice)) || 0,
      extendedPrice: parseFloat(String(li.extendedPrice)) || 0,
      cost: parseFloat(String(li.unitCost)) || 0,
      hours: parseFloat(String(li.laborHours)) || 0,
    })),
    totals,
    performedAt: sj.woCompletedDate || sj.woClosedDate || sj.createdAt,
    workOrderId: sj.workOrderId,
    workOrderNumber: sj.woNumber,
    sourceSystem: prov?.sourceSystem || "unknown",
    dataSource: "supabase" as const,
  };
}
