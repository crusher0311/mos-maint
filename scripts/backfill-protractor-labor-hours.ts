/**
 * Task #986 backfill: fill NULL labor_hours_billed on already-ingested
 * Protractor service jobs from their child labor lines.
 *
 * Background
 * ----------
 * Protractor service packages carry no package-level hours fields, so the
 * ingestion mapper left labor_hours_estimated/actual/billed NULL on every
 * Protractor row in normalized_service_jobs — even though the child labor
 * LINES (normalized_line_items, line_type='labor') carry real hours.
 * The mapper now sums labor-line hours at ingestion (see
 * lib/integrations/protractor/normalized-adapter.ts sumLaborLineHours),
 * but rows ingested before that change stay NULL until this backfill runs.
 *
 * Strategy
 * --------
 * Pure Postgres, set-based, per-shop chunks:
 *   For each Protractor shop, UPDATE normalized_service_jobs rows where all
 *   three hour columns are NULL, setting labor_hours_billed to the sum of
 *   labor_hours on the job's non-deleted labor lines (only when that sum
 *   is > 0 — 0 stays NULL, matching the mapper's sentinel-avoidance).
 *
 * SAFETY — this is a PRODUCTION data operation (operator-gated)
 * -------------------------------------------------------------
 * - DEFAULTS TO DRY RUN: reports what WOULD be updated; writes only with
 *   an explicit `--confirm`.
 * - Per-shop chunks with a per-statement LIMIT keep each UPDATE well under
 *   the ~2min PG statement timeout; paced with `--sleep` between chunks.
 * - Protractor-ONLY (provenance->>'sourceSystem' = 'protractor').
 * - Only fills NULLs — rows that already carry any hours value are never
 *   touched, so the run is idempotent and re-runnable.
 *
 * Usage
 * -----
 *   npx tsx scripts/backfill-protractor-labor-hours.ts                # DRY RUN, all protractor shops
 *   npx tsx scripts/backfill-protractor-labor-hours.ts --shop=66      # DRY RUN, one shop
 *   npx tsx scripts/backfill-protractor-labor-hours.ts --confirm      # LIVE write
 *   npx tsx scripts/backfill-protractor-labor-hours.ts --batch=5000   # rows per UPDATE (default 5000)
 *   npx tsx scripts/backfill-protractor-labor-hours.ts --sleep=250    # ms between chunks (default 250)
 */

import { sql } from "drizzle-orm";

interface Args {
  shop?: number;
  batch: number;
  sleepMs: number;
  confirm: boolean;
}

function posInt(flag: string, v: string | undefined, { allowZero = false } = {}): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
    console.error(`Invalid value for --${flag}: ${JSON.stringify(v)}`);
    process.exit(1);
  }
  return n;
}

function parseArgs(): Args {
  const out: Args = { batch: 5000, sleepMs: 250, confirm: false };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    switch (k) {
      case "shop": out.shop = posInt("shop", v); break;
      case "batch": out.batch = posInt("batch", v); break;
      case "sleep": out.sleepMs = posInt("sleep", v, { allowZero: true }); break;
      case "confirm": out.confirm = true; break;
      default: console.warn(`Unknown arg: --${k}`);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** drizzle execute(): SELECT → bare rows array; UPDATE → count on .count. */
function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}
function countOf(res: any): number {
  return Number(res?.count ?? res?.rowCount ?? 0);
}

async function main() {
  const args = parseArgs();
  const { getDb: getPg } = await import("../lib/db/drizzle");
  const db = getPg();

  console.log(args.confirm ? "LIVE RUN — writing to Postgres" : "DRY RUN — no writes (pass --confirm to write)");

  // The shared PG has a ~2min statement timeout; a giant shop's candidate
  // scan (all NULL rows × an indexed per-row line-hours subquery) can exceed
  // it. Widen it for this session only.
  await db.execute(sql`SET statement_timeout = '10min'`);

  // Which Protractor shops have NULL-hour service jobs at all?
  const shopFilter = args.shop != null ? sql` AND sj.shop_id = ${args.shop}` : sql``;
  const shopsRes = await db.execute(sql`
    SELECT sj.shop_id, count(*)::int AS null_rows
    FROM normalized_service_jobs sj
    WHERE sj.provenance->>'sourceSystem' = 'protractor'
      AND sj.labor_hours_billed IS NULL
      AND sj.labor_hours_actual IS NULL
      AND sj.labor_hours_estimated IS NULL
      ${shopFilter}
    GROUP BY sj.shop_id
    ORDER BY sj.shop_id
  `);
  const shops = rowsOf(shopsRes);
  console.log(`${shops.length} shop(s) with NULL-hour Protractor service jobs:`,
    shops.map((s: any) => `${s.shop_id}(${s.null_rows})`).join(" ") || "none");

  let totalUpdated = 0;
  for (const { shop_id } of shops) {
    let shopUpdated = 0;
    // Chunked UPDATE loop: each pass fills up to --batch rows, and because
    // it only targets still-NULL rows the loop naturally terminates.
    for (;;) {
      if (!args.confirm) {
        const res = await db.execute(sql`
          SELECT count(*)::int AS n
          FROM normalized_service_jobs sj
          WHERE sj.shop_id = ${shop_id}
            AND sj.provenance->>'sourceSystem' = 'protractor'
            AND sj.labor_hours_billed IS NULL
            AND sj.labor_hours_actual IS NULL
            AND sj.labor_hours_estimated IS NULL
            AND (SELECT sum(li.labor_hours) FROM normalized_line_items li
                 WHERE li.service_job_id = sj.id
                   AND li.line_type = 'labor'
                   AND (li.soft_delete->>'isDeleted')::boolean = false) > 0
        `);
        const n = Number(rowsOf(res)[0]?.n ?? 0);
        console.log(`shop ${shop_id}: WOULD update ${n} rows`);
        totalUpdated += n;
        break;
      }

      const res = await db.execute(sql`
        WITH candidates AS (
          SELECT sj.id,
                 (SELECT sum(li.labor_hours) FROM normalized_line_items li
                  WHERE li.service_job_id = sj.id
                    AND li.line_type = 'labor'
                    AND (li.soft_delete->>'isDeleted')::boolean = false) AS line_hours
          FROM normalized_service_jobs sj
          WHERE sj.shop_id = ${shop_id}
            AND sj.provenance->>'sourceSystem' = 'protractor'
            AND sj.labor_hours_billed IS NULL
            AND sj.labor_hours_actual IS NULL
            AND sj.labor_hours_estimated IS NULL
        ), fixable AS (
          -- Only rows whose labor lines actually carry hours; rows with
          -- hourless labor lines stay NULL forever (matching the mapper's
          -- "no hours → undefined" behavior) and must not clog the batch.
          SELECT id, line_hours FROM candidates
          WHERE line_hours > 0
          LIMIT ${args.batch}
        )
        UPDATE normalized_service_jobs sj
        SET labor_hours_billed = round(f.line_hours, 2),
            updated_at = now()
        FROM fixable f
        WHERE sj.id = f.id
      `);
      const updated = countOf(res);
      shopUpdated += updated;
      totalUpdated += updated;
      // fixable shrinks every pass (updated rows are no longer NULL), so the
      // loop terminates when a pass fills fewer than a full batch.
      if (updated < args.batch) break;
      await sleep(args.sleepMs);
    }
    if (args.confirm) console.log(`shop ${shop_id}: updated ${shopUpdated} rows`);
    await sleep(args.sleepMs);
  }

  console.log(`${args.confirm ? "Updated" : "Would update"} ${totalUpdated} service jobs total.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
