// Daily scenario sampler for the sales coaching trainer (task #987).
//
// Samples 3-5 varied real work orders from the canonical normalized
// Postgres store (mix of declined-work ROs, large estimates, routine ROs),
// snapshots the sales-relevant context, and stores them in
// sales_coach_scenarios. The unique index on work_order_id guarantees an RO
// is never served twice — inserts use ON CONFLICT DO NOTHING semantics via
// a pre-filter plus the unique-index safety net.
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import {
  salesCoachScenarios,
  type SalesCoachScenarioContext,
  type SalesCoachScenarioJob,
  type SalesCoachScenarioType,
} from "@/lib/db/schema/sales-coach";

const LARGE_ESTIMATE_MIN = 1500;
const ROUTINE_MIN = 100;
const ROUTINE_MAX = 600;
const LOOKBACK_DAYS = 120;
// The shared PG has a ~2 min statement timeout; `ORDER BY random()` over the
// full lookback window blows past it. Instead each bucket walks the
// created_at index backwards (newest first) into a bounded candidate pool,
// then randomizes within that pool — cheap and index-friendly.
const CANDIDATE_POOL = 2000;
// Declined-work ROs are sparse; cap the declined-job id scan so the daily
// query stays well inside the shared DB's ~2 min statement timeout.
const DECLINED_ID_SCAN_CAP = 2000;

export interface CandidateRow {
  id: string;
  shop_id: number;
  work_order_number: string | null;
  vehicle: any;
  customer: any;
  customer_concern: string | null;
  odometer_in: number | null;
  grand_total: string;
  closed_date: Date | null;
  provenance: any;
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// Money units differ by table AND provider in the normalized store
// (live-verified): normalized_work_orders.grand_total is CENTS for Tekmetric
// (dollars for others), while normalized_service_jobs money columns are
// DOLLARS for every provider. Scenario context is always snapshotted in
// dollars, so only the WO grand total needs scaling.
function moneyScale(sourceSystem: string | null | undefined): number {
  return sourceSystem === "tekmetric" ? 0.01 : 1;
}

const GRAND_TOTAL_DOLLARS = sql`(wo.grand_total::numeric * CASE WHEN wo.provenance->>'sourceSystem' = 'tekmetric' THEN 0.01 ELSE 1 END)`;

export async function fetchJobs(workOrderId: string): Promise<SalesCoachScenarioJob[]> {
  const db = getDb();
  const rows: any[] = await db.execute(sql`
    SELECT title, status, total, labor_total, parts_total,
           labor_hours_billed, labor_hours_estimated, declined_at, decline_reason
    FROM normalized_service_jobs
    WHERE work_order_id = ${workOrderId}
      AND (soft_delete->>'isDeleted')::boolean IS NOT TRUE
    ORDER BY sequence ASC
    LIMIT 40
  `);
  return rows.map((r) => ({
    title: r.title,
    status: r.status,
    // Service-job money columns are dollars for every provider — no scaling.
    total: Math.round((Number(r.total) || 0) * 100) / 100,
    laborTotal: Math.round((Number(r.labor_total) || 0) * 100) / 100,
    partsTotal: Math.round((Number(r.parts_total) || 0) * 100) / 100,
    laborHours: r.labor_hours_billed != null
      ? Number(r.labor_hours_billed)
      : r.labor_hours_estimated != null
        ? Number(r.labor_hours_estimated)
        : null,
    declined: r.status === "declined" || r.declined_at != null,
    declineReason: r.decline_reason ?? null,
  }));
}

export function buildContext(row: CandidateRow, jobs: SalesCoachScenarioJob[]): SalesCoachScenarioContext {
  const vehicle = row.vehicle
    ? { year: row.vehicle.year, make: row.vehicle.make, model: row.vehicle.model }
    : null;
  const firstName =
    row.customer?.firstName || row.customer?.first_name ||
    (typeof row.customer?.name === "string" ? row.customer.name.split(/\s+/)[0] : null) || null;
  return {
    vehicle,
    customerFirstName: firstName,
    customerConcern: row.customer_concern,
    odometerIn: row.odometer_in,
    workOrderNumber: row.work_order_number,
    grandTotal: Math.round((Number(row.grand_total) || 0) * moneyScale(row.provenance?.sourceSystem) * 100) / 100,
    jobs,
    declinedTotal: jobs.filter((j) => j.declined).reduce((s, j) => s + j.total, 0),
    provider: row.provenance?.sourceSystem ?? null,
    closedDate: row.closed_date ? new Date(row.closed_date).toISOString() : null,
  };
}

const BASE_FILTER = sql`
  (wo.soft_delete->>'isDeleted')::boolean IS NOT TRUE
  AND wo.is_internal = false
  AND wo.grand_total::numeric > 0
  AND wo.vehicle IS NOT NULL
  AND (wo.closed_date IS NULL OR wo.closed_date > now() - make_interval(days => ${LOOKBACK_DAYS}))
  AND wo.created_at > now() - make_interval(days => ${LOOKBACK_DAYS})
  AND NOT EXISTS (SELECT 1 FROM sales_coach_scenarios s WHERE s.work_order_id = wo.id)
`;

const SELECT_COLS = sql`
  wo.id, wo.shop_id, wo.work_order_number, wo.vehicle, wo.customer,
  wo.customer_concern, wo.odometer_in, wo.grand_total, wo.closed_date, wo.provenance
`;

/**
 * Two-stage sampling that keeps the planner honest:
 *  1. `poolFilter` (cheap, per-row predicates only) runs inside a
 *     created_at-DESC index walk capped at CANDIDATE_POOL rows.
 *  2. `postFilter` (e.g. the declined-jobs EXISTS) runs only against that
 *     bounded pool, so any subquery probes hit at most a few thousand rows
 *     via nsj_work_order_id_idx instead of seq-scanning the jobs table.
 */
// Every candidate must have at least one non-deleted, priced service job —
// otherwise there is nothing to pitch and the row would be discarded later.
const HAS_JOBS = sql`EXISTS (
  SELECT 1 FROM normalized_service_jobs sj
  WHERE sj.work_order_id = wo.id
    AND (sj.soft_delete->>'isDeleted')::boolean IS NOT TRUE
    AND sj.total::numeric > 0
)`;

async function samplePool(
  poolFilter: ReturnType<typeof sql>,
  postFilter: ReturnType<typeof sql>,
  limit: number,
  excludeIds: string[],
  poolSize = CANDIDATE_POOL,
): Promise<CandidateRow[]> {
  const db = getDb();
  const excludeClause = excludeIds.length
    ? sql`AND wo.id NOT IN (${sql.join(excludeIds.map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  // Pool stage carries ids only so a deep pool stays cheap; full columns are
  // fetched for the handful of finalists at the end.
  const rows: any[] = await db.execute(sql`
    WITH pool AS (
      SELECT wo.id
      FROM normalized_work_orders wo
      WHERE ${BASE_FILTER}
        AND ${poolFilter}
        ${excludeClause}
      ORDER BY wo.created_at DESC
      LIMIT ${poolSize}
    ),
    finalists AS (
      SELECT wo.id FROM pool wo
      WHERE ${HAS_JOBS} AND ${postFilter}
      ORDER BY random()
      LIMIT ${limit}
    )
    SELECT ${SELECT_COLS}
    FROM normalized_work_orders wo
    WHERE wo.id IN (SELECT id FROM finalists)
  `);
  return rows as CandidateRow[];
}

/**
 * Declined-work ROs are too sparse (<1% of service jobs, and heavily
 * backfilled so import order doesn't help) for the pooled index walk.
 * Instead: grab a capped batch of declined-job work_order_ids (bounded seq
 * scan, ~30-90s once a day), dedupe in JS, then randomly pick qualifying
 * work orders from that id set — the second query is instant.
 * Note: declined jobs often carry $0 totals (known upstream data quirk), so
 * no price floor is applied here.
 */
async function sampleDeclined(limit: number): Promise<CandidateRow[]> {
  const db = getDb();
  const idRows: any[] = await db.execute(sql`
    SELECT sj.work_order_id FROM normalized_service_jobs sj
    WHERE sj.status = 'declined'
    LIMIT ${DECLINED_ID_SCAN_CAP}
  `);
  const uniq = [...new Set(idRows.map((r) => String(r.work_order_id)))]
    .filter((id) => /^[A-Za-z0-9_:-]+$/.test(id));
  if (uniq.length === 0) return [];
  const idArrayLiteral = sql.raw(`'{${uniq.map((id) => `"${id}"`).join(",")}}'::varchar[]`);
  const rows: any[] = await db.execute(sql`
    SELECT ${SELECT_COLS}
    FROM normalized_work_orders wo
    WHERE wo.id = ANY(${idArrayLiteral})
      AND ${BASE_FILTER}
      AND ${HAS_JOBS}
    ORDER BY random()
    LIMIT ${limit}
  `);
  return rows as CandidateRow[];
}

function sampleLargeEstimate(limit: number, excludeIds: string[]): Promise<CandidateRow[]> {
  return samplePool(sql`${GRAND_TOTAL_DOLLARS} >= ${LARGE_ESTIMATE_MIN}`, sql`true`, limit, excludeIds);
}

function sampleRoutine(limit: number, excludeIds: string[]): Promise<CandidateRow[]> {
  return samplePool(sql`${GRAND_TOTAL_DOLLARS} BETWEEN ${ROUTINE_MIN} AND ${ROUTINE_MAX}`, sql`true`, limit, excludeIds);
}

export interface GenerateResult {
  date: string;
  created: number;
  existing: number;
  byType: Record<string, number>;
}

/**
 * Generate today's scenarios if fewer than `target` exist for today.
 * Idempotent per UTC day; safe to call from the cron and the manual
 * "generate now" trigger.
 */
export async function generateDailyScenarios(target = 5): Promise<GenerateResult> {
  const db = getDb();
  const date = utcToday();

  const existingRows: any[] = await db.execute(sql`
    SELECT count(*)::int AS n FROM sales_coach_scenarios WHERE scenario_date = ${date}
  `);
  const existing = existingRows[0]?.n ?? 0;
  const needed = Math.max(0, target - existing);
  const byType: Record<string, number> = {};
  if (needed === 0) return { date, created: 0, existing, byType };

  // Mix: prefer 2 declined, 2 large, 1 routine (scaled down when fewer
  // slots remain); backfill from other buckets when one runs dry.
  const wantDeclined = Math.min(2, needed);
  const declined = await sampleDeclined(wantDeclined);
  const picked: Array<{ row: CandidateRow; type: SalesCoachScenarioType }> =
    declined.map((row) => ({ row, type: "declined_work" as const }));

  let remaining = needed - picked.length;
  if (remaining > 0) {
    const large = await sampleLargeEstimate(Math.min(2, remaining), picked.map((p) => p.row.id));
    picked.push(...large.map((row) => ({ row, type: "large_estimate" as const })));
    remaining = needed - picked.length;
  }
  if (remaining > 0) {
    const routine = await sampleRoutine(remaining, picked.map((p) => p.row.id));
    picked.push(...routine.map((row) => ({ row, type: "routine" as const })));
    remaining = needed - picked.length;
  }
  // Last resort: top up with more large estimates so we still hit 3-5.
  if (remaining > 0) {
    const more = await sampleLargeEstimate(remaining, picked.map((p) => p.row.id));
    picked.push(...more.map((row) => ({ row, type: "large_estimate" as const })));
  }

  let created = 0;
  for (const { row, type } of picked) {
    const jobs = await fetchJobs(row.id);
    if (jobs.length === 0) continue; // nothing to pitch
    const context = buildContext(row, jobs);
    try {
      await db.insert(salesCoachScenarios).values({
        scenarioDate: date,
        scenarioType: type,
        shopId: row.shop_id,
        workOrderId: row.id,
        workOrderNumber: row.work_order_number,
        context,
      }).onConflictDoNothing();
      created++;
      byType[type] = (byType[type] ?? 0) + 1;
    } catch (err: any) {
      console.warn(`[SalesCoach] scenario insert failed for WO ${row.id}: ${err?.message || err}`);
    }
  }

  console.log(`[SalesCoach] generated ${created} scenarios for ${date} (existing=${existing})`);
  return { date, created, existing, byType };
}
