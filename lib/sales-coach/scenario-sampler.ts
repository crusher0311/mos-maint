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
const LOOKBACK_DAYS = 365;

interface CandidateRow {
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

async function fetchJobs(workOrderId: string): Promise<SalesCoachScenarioJob[]> {
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
    total: Number(r.total) || 0,
    laborTotal: Number(r.labor_total) || 0,
    partsTotal: Number(r.parts_total) || 0,
    laborHours: r.labor_hours_billed != null
      ? Number(r.labor_hours_billed)
      : r.labor_hours_estimated != null
        ? Number(r.labor_hours_estimated)
        : null,
    declined: r.status === "declined" || r.declined_at != null,
    declineReason: r.decline_reason ?? null,
  }));
}

function buildContext(row: CandidateRow, jobs: SalesCoachScenarioJob[]): SalesCoachScenarioContext {
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
    grandTotal: Number(row.grand_total) || 0,
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

async function sampleDeclined(limit: number): Promise<CandidateRow[]> {
  const db = getDb();
  const rows: any[] = await db.execute(sql`
    SELECT ${SELECT_COLS}
    FROM normalized_work_orders wo
    WHERE ${BASE_FILTER}
      AND EXISTS (
        SELECT 1 FROM normalized_service_jobs sj
        WHERE sj.work_order_id = wo.id
          AND (sj.status = 'declined' OR sj.declined_at IS NOT NULL)
          AND sj.total::numeric > 50
      )
    ORDER BY random()
    LIMIT ${limit}
  `);
  return rows as CandidateRow[];
}

async function sampleLargeEstimate(limit: number, excludeIds: string[]): Promise<CandidateRow[]> {
  const db = getDb();
  const rows: any[] = await db.execute(sql`
    SELECT ${SELECT_COLS}
    FROM normalized_work_orders wo
    WHERE ${BASE_FILTER}
      AND wo.grand_total::numeric >= ${LARGE_ESTIMATE_MIN}
      AND wo.id != ALL(${excludeIds.length ? excludeIds : [""]}::varchar[])
    ORDER BY random()
    LIMIT ${limit}
  `);
  return rows as CandidateRow[];
}

async function sampleRoutine(limit: number, excludeIds: string[]): Promise<CandidateRow[]> {
  const db = getDb();
  const rows: any[] = await db.execute(sql`
    SELECT ${SELECT_COLS}
    FROM normalized_work_orders wo
    WHERE ${BASE_FILTER}
      AND wo.grand_total::numeric BETWEEN ${ROUTINE_MIN} AND ${ROUTINE_MAX}
      AND wo.id != ALL(${excludeIds.length ? excludeIds : [""]}::varchar[])
    ORDER BY random()
    LIMIT ${limit}
  `);
  return rows as CandidateRow[];
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
