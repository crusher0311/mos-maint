/**
 * Postgres-backed repository for the `shop_repair_patterns` Mongo
 * collection (task #1000).
 *
 * Used by `lib/repair-patterns.ts` when `REPAIR_PATTERNS_PG_CANONICAL=1`.
 * The doc is keyed by the natural key
 * `(shopId, year, make, model, mileageBucket, jobTitleNormalized)` and
 * carries rolling occurrence/labour/parts/hours aggregates plus a capped
 * `vinsSeen` array. Enterprise reads aggregate across every shop that
 * shares an `enterpriseId`.
 *
 * These functions are pure PG; the flag dispatch + Mongo shadow-write live
 * in `lib/repair-patterns.ts`. The `enterpriseId` is stored as text here
 * (the Mongo side keeps an ObjectId); callers pass the hex string.
 */
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { shopRepairPatterns } from "@/lib/db/schema/wave2";

const VINS_SEEN_CAP = 100;

export interface UpdateRepairPatternParams {
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  mileageBucket: number;
  jobTitle: string;
  jobTitleNormalized: string;
  laborAmount: number;
  partsAmount: number;
  totalAmount: number;
  laborHours: number;
  vin?: string;
  performedDate: Date;
}

/**
 * Upsert-and-recompute for a single learned pattern. Mirrors the two-step
 * Mongo update (increment counters + $addToSet vin, then recompute the
 * rolling averages). The `avgHours` running-mean formula matches the Mongo
 * pipeline exactly.
 */
export async function updateRepairPattern(
  params: UpdateRepairPatternParams,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  const labor = params.laborAmount || 0;
  const parts = params.partsAmount || 0;
  const total = params.totalAmount || 0;

  // vinsSeen: append if not present, capped at VINS_SEEN_CAP (Mongo $addToSet
  // has no cap, but the Mongo comment documents the 100 cap intent; we keep
  // the array from growing unbounded while preserving set semantics).
  const vinAppend = params.vin
    ? sql`
        CASE
          WHEN coalesce(${shopRepairPatterns.vinsSeen}, '[]'::jsonb) @> ${JSON.stringify([params.vin])}::jsonb
            THEN ${shopRepairPatterns.vinsSeen}
          ELSE (
            SELECT jsonb_agg(v) FROM (
              SELECT v FROM jsonb_array_elements(
                coalesce(${shopRepairPatterns.vinsSeen}, '[]'::jsonb) || ${JSON.stringify([params.vin])}::jsonb
              ) AS v
              LIMIT ${VINS_SEEN_CAP}
            ) capped
          )
        END`
    : sql`coalesce(${shopRepairPatterns.vinsSeen}, '[]'::jsonb)`;

  const newOccurrences = sql`${shopRepairPatterns.occurrences} + 1`;
  const newTotalLabor = sql`${shopRepairPatterns.totalLabor} + ${labor}`;
  const newTotalParts = sql`${shopRepairPatterns.totalParts} + ${parts}`;
  const newTotalAmount = sql`${shopRepairPatterns.totalAmount} + ${total}`;
  // Running mean of hours: (avgHours * (occ-1) + laborHours) / occ, only when
  // laborHours > 0 (else keep the prior avgHours). occ here is the NEW count.
  const newAvgHours =
    params.laborHours > 0
      ? sql`((${shopRepairPatterns.avgHours} * ${shopRepairPatterns.occurrences}) + ${params.laborHours}) / (${shopRepairPatterns.occurrences} + 1)`
      : sql`${shopRepairPatterns.avgHours}`;

  await db
    .insert(shopRepairPatterns)
    .values({
      shopId: params.shopId,
      enterpriseId: params.enterpriseId ?? null,
      year: params.year,
      make: params.make.toUpperCase(),
      model: params.model.toUpperCase(),
      mileageBucket: params.mileageBucket,
      jobTitle: params.jobTitle,
      jobTitleNormalized: params.jobTitleNormalized,
      occurrences: 1,
      totalLabor: labor,
      totalParts: parts,
      totalAmount: total,
      avgLabor: labor,
      avgParts: parts,
      avgTotal: total,
      avgHours: params.laborHours > 0 ? params.laborHours : 0,
      lastPerformed: params.performedDate,
      firstPerformed: params.performedDate,
      vinsSeen: params.vin ? [params.vin] : [],
      createdAt: now,
      updatedAt: now,
    } as typeof shopRepairPatterns.$inferInsert)
    .onConflictDoUpdate({
      target: [
        shopRepairPatterns.shopId,
        shopRepairPatterns.year,
        shopRepairPatterns.make,
        shopRepairPatterns.model,
        shopRepairPatterns.mileageBucket,
        shopRepairPatterns.jobTitleNormalized,
      ],
      set: {
        jobTitle: params.jobTitle,
        enterpriseId: params.enterpriseId ?? null,
        updatedAt: now,
        occurrences: newOccurrences,
        totalLabor: newTotalLabor,
        totalParts: newTotalParts,
        totalAmount: newTotalAmount,
        avgLabor: sql`${newTotalLabor} / ${newOccurrences}`,
        avgParts: sql`${newTotalParts} / ${newOccurrences}`,
        avgTotal: sql`${newTotalAmount} / ${newOccurrences}`,
        avgHours: newAvgHours,
        lastPerformed: sql`GREATEST(${shopRepairPatterns.lastPerformed}, ${params.performedDate})`,
        firstPerformed: sql`LEAST(${shopRepairPatterns.firstPerformed}, ${params.performedDate})`,
        vinsSeen: vinAppend,
      } as Partial<typeof shopRepairPatterns.$inferInsert>,
    });
}

/** Batch equivalent — sequential upserts. Returns the number processed. */
export async function updateRepairPatternBatch(
  jobs: UpdateRepairPatternParams[],
): Promise<number> {
  let count = 0;
  for (const job of jobs) {
    try {
      await updateRepairPattern(job);
      count += 1;
    } catch (err) {
      console.error("[pg repair-patterns] batch upsert error:", err);
    }
  }
  return count;
}

export interface ShopPatternRow {
  jobTitle: string;
  occurrences: number;
  avgTotal: number;
  avgHours: number;
  avgLabor: number;
  avgParts: number;
  lastPerformed: Date | null;
  mileageBucket: number | null;
  uniqueVehicles: number;
}

/**
 * Mirrors `getShopPatterns`'s Mongo `find(...).sort({occurrences:-1}).limit()`.
 * `buckets`/`modelVariants` are pre-computed by the caller (same helpers).
 * When `includeEnterprise` + `enterpriseId`, scope by enterprise; else shop.
 */
export async function getShopPatterns(params: {
  shopId: number;
  enterpriseId?: string;
  year: number;
  make: string;
  model: string;
  buckets: number[];
  modelVariants: string[];
  includeEnterprise?: boolean;
  limit: number;
}): Promise<ShopPatternRow[]> {
  const db = getDb();
  const scope: SQL =
    params.includeEnterprise && params.enterpriseId
      ? eq(shopRepairPatterns.enterpriseId, params.enterpriseId)
      : eq(shopRepairPatterns.shopId, params.shopId);

  const rows = await db
    .select()
    .from(shopRepairPatterns)
    .where(
      and(
        scope,
        eq(shopRepairPatterns.year, params.year),
        eq(shopRepairPatterns.make, params.make.toUpperCase()),
        inArray(shopRepairPatterns.model, params.modelVariants),
        inArray(shopRepairPatterns.mileageBucket, params.buckets),
        sql`${shopRepairPatterns.occurrences} >= 2`,
      ),
    )
    .orderBy(desc(shopRepairPatterns.occurrences))
    .limit(params.limit);

  return rows.map((p) => ({
    jobTitle: p.jobTitle ?? "",
    occurrences: p.occurrences,
    avgTotal: p.avgTotal,
    avgHours: p.avgHours,
    avgLabor: p.avgLabor,
    avgParts: p.avgParts,
    lastPerformed: p.lastPerformed,
    mileageBucket: p.mileageBucket,
    uniqueVehicles: Array.isArray(p.vinsSeen) ? (p.vinsSeen as unknown[]).length : 0,
  }));
}

export interface EnterprisePatternRow {
  jobTitle: string;
  occurrences: number;
  avgTotal: number;
  avgLabor: number;
  avgParts: number;
  lastPerformed: Date | null;
  mileageBucket: number | null;
  shopCount: number;
}

/**
 * Mirrors `getEnterprisePatterns`'s Mongo aggregate: group across enterprise
 * shops by `jobTitleNormalized`, keep groups with total occurrences >= 2,
 * order by total occurrences desc.
 */
export async function getEnterprisePatterns(params: {
  enterpriseId: string;
  year: number;
  make: string;
  model: string;
  buckets: number[];
  modelVariants: string[];
  limit: number;
}): Promise<EnterprisePatternRow[]> {
  const db = getDb();
  const totalOcc = sql<number>`sum(${shopRepairPatterns.occurrences})`.as("total_occ");

  const rows = await db
    .select({
      jobTitle: sql<string>`min(${shopRepairPatterns.jobTitle})`.as("job_title"),
      totalOccurrences: totalOcc,
      totalLabor: sql<number>`sum(${shopRepairPatterns.totalLabor})`.as("total_labor"),
      totalParts: sql<number>`sum(${shopRepairPatterns.totalParts})`.as("total_parts"),
      totalAmount: sql<number>`sum(${shopRepairPatterns.totalAmount})`.as("total_amount"),
      lastPerformed: sql<Date | null>`max(${shopRepairPatterns.lastPerformed})`.as("last_performed"),
      mileageBucket: sql<number | null>`min(${shopRepairPatterns.mileageBucket})`.as("mileage_bucket"),
      shopCount: sql<number>`count(*)`.as("shop_count"),
    })
    .from(shopRepairPatterns)
    .where(
      and(
        eq(shopRepairPatterns.enterpriseId, params.enterpriseId),
        eq(shopRepairPatterns.year, params.year),
        eq(shopRepairPatterns.make, params.make.toUpperCase()),
        inArray(shopRepairPatterns.model, params.modelVariants),
        inArray(shopRepairPatterns.mileageBucket, params.buckets),
      ),
    )
    .groupBy(shopRepairPatterns.jobTitleNormalized)
    .having(sql`sum(${shopRepairPatterns.occurrences}) >= 2`)
    .orderBy(sql`sum(${shopRepairPatterns.occurrences}) desc`)
    .limit(params.limit);

  return rows.map((r) => {
    const occ = Number(r.totalOccurrences) || 0;
    return {
      jobTitle: r.jobTitle ?? "",
      occurrences: occ,
      avgTotal: occ ? Number(r.totalAmount) / occ : 0,
      avgLabor: occ ? Number(r.totalLabor) / occ : 0,
      avgParts: occ ? Number(r.totalParts) / occ : 0,
      lastPerformed: r.lastPerformed,
      mileageBucket: r.mileageBucket,
      shopCount: Number(r.shopCount) || 0,
    };
  });
}
