/**
 * backfill-protractor-dates-fast.ts
 * ---------------------------------
 * Fast, date-ONLY backfill for Protractor work-order business dates.
 *
 * Why this exists: scripts/backfill-protractor-history-dates.ts replays the
 * FULL ingest pipeline (work order + service jobs + line items) per WO, which
 * measured ~0.3 WOs/sec against the 1.2M-row Protractor fleet — weeks of
 * runtime. But the actual gap (task follow-up to #640) is only that rows
 * ingested before the adapter date fix have NULL closed_date/completed_date
 * (so Data Status falls back to the MOS import timestamp), plus ~55 rows that
 * carry Protractor's .NET DateTime.MinValue sentinel (year 0001).
 *
 * This script fixes exactly that and nothing else:
 *   1. Streams Mongo `normalized_work_orders` (protractor only) with a tiny
 *      projection of the raw-payload date fields.
 *   2. Computes closed/check-in dates with the same resolution order as
 *      ProtractorAdapter.mapWorkOrder, including the pre-1990 sentinel guard.
 *   3. Batch-updates Postgres `normalized_work_orders` by the natural key
 *      (shop_id, work_order_number), touching ONLY date columns and ONLY on
 *      rows whose dates are NULL or garbage (< 1990). Terminal statuses only
 *      (invoiced/paid/closed) so genuinely-open WOs never gain a closed date.
 *   4. `--service-jobs` phase: set-based PG update filling
 *      normalized_service_jobs.completed_at from the parent WO's closed_date
 *      (mirrors the adapter's _parentClosedAt fallback), chunked.
 *
 * Safety
 * ------
 *   - DRY RUN by default; `--confirm` required to write.
 *   - Resumable via .local/backfill-protractor-dates-fast-checkpoint.json.
 *   - Never touches Tekmetric / Shop-Ware rows (provenance filter in SQL).
 *   - Only ever SETs date columns that are currently NULL or pre-1990.
 *
 * Usage
 * -----
 *   npx tsx scripts/backfill-protractor-dates-fast.ts                 # dry run
 *   npx tsx scripts/backfill-protractor-dates-fast.ts --confirm       # live
 *   npx tsx scripts/backfill-protractor-dates-fast.ts --shop=143      # one shop
 *   npx tsx scripts/backfill-protractor-dates-fast.ts --confirm --service-jobs
 *   npx tsx scripts/backfill-protractor-dates-fast.ts --reset         # drop checkpoint
 */

import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb as getMongoDb } from "../lib/mongo";

interface Args {
  shop?: number;
  batch: number;
  flush: number;
  sleepMs: number;
  reset: boolean;
  confirm: boolean;
  serviceJobs: boolean;
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
  const out: Args = {
    batch: 2000,
    flush: 500,
    sleepMs: 100,
    reset: false,
    confirm: false,
    serviceJobs: false,
  };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    switch (k) {
      case "shop": out.shop = posInt("shop", v); break;
      case "batch": out.batch = posInt("batch", v); break;
      case "flush": out.flush = posInt("flush", v); break;
      case "sleep": out.sleepMs = posInt("sleep", v, { allowZero: true }); break;
      case "reset": out.reset = true; break;
      case "confirm": out.confirm = true; break;
      case "service-jobs": out.serviceJobs = true; break;
      default: console.warn(`Unknown arg: --${k}`);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** drizzle's execute() returns a bare array of rows for SELECTs (postgres-js
 * driver) — there is no `.rows` property. For UPDATEs the array is empty and
 * the affected-row count lives on `.count`. */
function rowsOf(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}
function countOf(res: any): number {
  return Number(res?.count ?? res?.rowCount ?? 0);
}

const CHECKPOINT_FILE = path.join(
  process.cwd(),
  ".local",
  "backfill-protractor-dates-fast-checkpoint.json",
);

interface Checkpoint {
  lastId: string | null;
  scanned: number;
  candidates: number;
  rowsUpdated: number;
  finishedAt?: string;
}

function loadCheckpoints(): Record<string, Checkpoint> {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCheckpoints(all: Record<string, Checkpoint>) {
  fs.mkdirSync(path.dirname(CHECKPOINT_FILE), { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(all, null, 2));
}

/** Mirror of ProtractorAdapter's parseBusinessDate: reject unparsable AND
 * pre-1990 sentinel dates (Protractor emits .NET DateTime.MinValue,
 * "0001-01-01T00:00:00", for "no date"). */
function parseBusinessDate(value: any): Date | undefined {
  if (!value) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  if (isNaN(parsed.getTime())) return undefined;
  return parsed.getFullYear() < 1990 ? undefined : parsed;
}

interface Candidate {
  shopId: number;
  workOrderNumber: string;
  closedIso: string;
  checkInIso: string | null;
}

async function backfillWorkOrderDates(args: Args) {
  const live = args.confirm;
  const key = `${live ? "live" : "dry"}:${args.shop != null ? `shop=${args.shop}` : "all"}`;

  const all = loadCheckpoints();
  if (args.reset) delete all[key];
  const cp: Checkpoint = all[key] ?? { lastId: null, scanned: 0, candidates: 0, rowsUpdated: 0 };
  delete cp.finishedAt;

  console.log(`[dates-fast] mode=${live ? "LIVE" : "DRY RUN"} key=${key} batch=${args.batch} flush=${args.flush}`);

  const mongo = await getMongoDb();
  const coll = mongo.collection("normalized_work_orders");
  const { getDb: getPg } = await import("../lib/db/drizzle");
  const pg = getPg();

  const filter: Record<string, any> = { "provenance.sourceSystem": "protractor" };
  if (args.shop != null) filter.shopId = args.shop;
  if (cp.lastId) filter._id = { $gt: cp.lastId } as any;

  const total = await coll.countDocuments(filter);
  console.log(`  ${total.toLocaleString()} protractor WOs to scan${cp.lastId ? ` (resuming after ${cp.lastId})` : ""}`);

  const cursor = coll
    .find(filter, {
      projection: {
        shopId: 1,
        workOrderNumber: 1,
        "rawPayload.InvoiceTime": 1,
        "rawPayload.ClosedDate": 1,
        "rawPayload.InvoiceDate": 1,
        "rawPayload.DateIn": 1,
        "rawPayload.CreatedDate": 1,
        "rawPayload.ScheduledTime": 1,
        "rawPayload.Header.CreationTime": 1,
        "rawPayload.Header.LastModifiedTime": 1,
      },
    })
    .sort({ _id: 1 })
    .batchSize(args.batch);

  const startedAt = Date.now();
  let pending: Candidate[] = [];
  let lastFlushedId: string | null = cp.lastId;

  const flush = async (tailId: string | null) => {
    if (pending.length) {
      const rows = pending;
      pending = [];
      cp.candidates += rows.length;

      const values = sql.join(
        rows.map(
          (r) =>
            sql`(${r.shopId}::int, ${r.workOrderNumber}::text, ${r.closedIso}::timestamp, ${r.checkInIso}::timestamp)`,
        ),
        sql`, `,
      );

      if (live) {
        const res = await pg.execute(sql`
          UPDATE normalized_work_orders nwo SET
            closed_date    = CASE WHEN nwo.closed_date    IS NULL OR nwo.closed_date    < '1990-01-01' THEN v.closed_at ELSE nwo.closed_date END,
            completed_date = CASE WHEN nwo.completed_date IS NULL OR nwo.completed_date < '1990-01-01' THEN v.closed_at ELSE nwo.completed_date END,
            check_in_date  = CASE WHEN (nwo.check_in_date IS NULL OR nwo.check_in_date  < '1990-01-01') AND v.check_in_at IS NOT NULL THEN v.check_in_at ELSE nwo.check_in_date END
          FROM (VALUES ${values}) AS v(shop_id, wo_num, closed_at, check_in_at)
          WHERE nwo.shop_id = v.shop_id
            AND nwo.work_order_number = v.wo_num
            AND nwo.provenance->>'sourceSystem' = 'protractor'
            AND nwo.status IN ('invoiced', 'paid', 'closed')
            AND (
              nwo.closed_date IS NULL OR nwo.closed_date < '1990-01-01'
              OR nwo.completed_date IS NULL OR nwo.completed_date < '1990-01-01'
              OR ((nwo.check_in_date IS NULL OR nwo.check_in_date < '1990-01-01') AND v.check_in_at IS NOT NULL)
            )
        `);
        cp.rowsUpdated += countOf(res);
      } else {
        const res = await pg.execute(sql`
          SELECT count(*)::int AS n
          FROM normalized_work_orders nwo
          JOIN (VALUES ${values}) AS v(shop_id, wo_num, closed_at, check_in_at)
            ON nwo.shop_id = v.shop_id AND nwo.work_order_number = v.wo_num
          WHERE nwo.provenance->>'sourceSystem' = 'protractor'
            AND nwo.status IN ('invoiced', 'paid', 'closed')
            AND (
              nwo.closed_date IS NULL OR nwo.closed_date < '1990-01-01'
              OR nwo.completed_date IS NULL OR nwo.completed_date < '1990-01-01'
              OR ((nwo.check_in_date IS NULL OR nwo.check_in_date < '1990-01-01') AND v.check_in_at IS NOT NULL)
            )
        `);
        cp.rowsUpdated += Number(rowsOf(res)[0]?.n ?? 0);
      }
      if (args.sleepMs) await sleep(args.sleepMs);
    }

    if (tailId) {
      cp.lastId = tailId;
      lastFlushedId = tailId;
    }
    all[key] = cp;
    saveCheckpoints(all);

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = cp.scanned / Math.max(elapsed, 1);
    const eta = Math.max(0, Math.round((total - cp.scanned) / Math.max(rate, 1)));
    console.log(
      `  scanned=${cp.scanned.toLocaleString()}/${total.toLocaleString()} candidates=${cp.candidates.toLocaleString()} ` +
        `${live ? "updated" : "would-update"}=${cp.rowsUpdated.toLocaleString()} rate=${rate.toFixed(0)}/s eta=${eta}s`,
    );
  };

  let sinceFlush = 0;
  let tailId: string | null = null;
  for await (const doc of cursor) {
    cp.scanned++;
    sinceFlush++;
    tailId = String(doc._id);

    const raw = doc.rawPayload ?? {};
    const closed = parseBusinessDate(
      raw.InvoiceTime || raw.ClosedDate || raw.InvoiceDate || raw.Header?.LastModifiedTime,
    );
    if (closed) {
      const checkIn = parseBusinessDate(
        raw.Header?.CreationTime || raw.DateIn || raw.CreatedDate || raw.ScheduledTime,
      );
      pending.push({
        shopId: doc.shopId,
        workOrderNumber: String(doc.workOrderNumber ?? ""),
        closedIso: closed.toISOString(),
        checkInIso: checkIn ? checkIn.toISOString() : null,
      });
    }

    if (pending.length >= args.flush || sinceFlush >= args.batch * 5) {
      await flush(tailId);
      sinceFlush = 0;
    }
  }
  await flush(tailId);

  cp.finishedAt = new Date().toISOString();
  all[key] = cp;
  saveCheckpoints(all);
  console.log(
    `[dates-fast] DONE (${live ? "LIVE" : "DRY RUN"}) scanned=${cp.scanned.toLocaleString()} ` +
      `candidates=${cp.candidates.toLocaleString()} ${live ? "updated" : "would-update"}=${cp.rowsUpdated.toLocaleString()}`,
  );
}

/** Phase 2: fill normalized_service_jobs.completed_at from the parent WO's
 * closed_date (mirrors the adapter's _parentClosedAt fallback).
 *
 * Chunked PER SHOP: a fleet-wide `LIMIT 5000` re-scans the whole multi-million
 * row join to find each next chunk (the scan restarts from the beginning every
 * statement), which blew the DB's statement timeout on the second chunk.
 * Scoping every statement to one shop keeps each scan bounded by that shop's
 * row count, so no single statement can run away. Idempotent — rows updated
 * once no longer match the WHERE, so re-running after a failure is safe. */
async function backfillServiceJobDates(args: Args) {
  const live = args.confirm;
  const { getDb: getPg } = await import("../lib/db/drizzle");
  const pg = getPg();

  const shopsRes = await pg.execute(sql`
    SELECT DISTINCT shop_id FROM normalized_work_orders
    WHERE provenance->>'sourceSystem' = 'protractor'
    ${args.shop != null ? sql`AND shop_id = ${args.shop}` : sql``}
    ORDER BY shop_id
  `);
  const shopIds: number[] = rowsOf(shopsRes).map((r: any) => Number(r.shop_id));
  console.log(`[dates-fast/sj] mode=${live ? "LIVE" : "DRY RUN"} — ${shopIds.length} protractor shop(s)`);

  let total = 0;
  for (const shopId of shopIds) {
    if (!live) {
      const res = await pg.execute(sql`
        SELECT count(*)::int AS n
        FROM normalized_service_jobs sj
        JOIN normalized_work_orders wo ON wo.id = sj.work_order_id AND wo.shop_id = sj.shop_id
        WHERE sj.shop_id = ${shopId}
          AND (sj.completed_at IS NULL OR sj.completed_at < '1990-01-01')
          AND wo.closed_date IS NOT NULL AND wo.closed_date >= '1990-01-01'
          AND wo.provenance->>'sourceSystem' = 'protractor'
      `);
      const n = Number(rowsOf(res)[0]?.n ?? 0);
      total += n;
      if (n > 0) console.log(`  [sj] shop ${shopId}: would fill ${n.toLocaleString()}`);
      continue;
    }

    let shopTotal = 0;
    for (;;) {
      const res = await pg.execute(sql`
        WITH batch AS (
          SELECT sj.id, wo.closed_date
          FROM normalized_service_jobs sj
          JOIN normalized_work_orders wo ON wo.id = sj.work_order_id AND wo.shop_id = sj.shop_id
          WHERE sj.shop_id = ${shopId}
            AND (sj.completed_at IS NULL OR sj.completed_at < '1990-01-01')
            AND wo.closed_date IS NOT NULL AND wo.closed_date >= '1990-01-01'
            AND wo.provenance->>'sourceSystem' = 'protractor'
          LIMIT 5000
        )
        UPDATE normalized_service_jobs sj
        SET completed_at = batch.closed_date
        FROM batch
        WHERE sj.id = batch.id
      `);
      const n = countOf(res);
      shopTotal += n;
      if (n === 0) break;
      if (args.sleepMs) await sleep(args.sleepMs);
    }
    total += shopTotal;
    if (shopTotal > 0) console.log(`  [sj] shop ${shopId}: filled ${shopTotal.toLocaleString()} (running total ${total.toLocaleString()})`);
  }
  console.log(`[dates-fast/sj] DONE (${live ? "LIVE" : "DRY RUN"}) — ${live ? "filled" : "would fill"} completed_at on ${total.toLocaleString()} service jobs`);
}

async function main() {
  const args = parseArgs();
  if (args.serviceJobs) {
    await backfillServiceJobDates(args);
  } else {
    await backfillWorkOrderDates(args);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[dates-fast] FATAL:", err);
  process.exit(1);
});
