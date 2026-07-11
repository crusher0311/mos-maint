/**
 * Task #810 backfill: fill REAL part costs into already-indexed Protractor
 * job history.
 *
 * Background
 * ----------
 * Task #681 made the extractors capture Protractor's flat `Cost` / `TotalCost`
 * fields onto job_index lines (`cost` / `extendedCost`) and normalized line
 * items — but only for rows indexed/normalized AFTER that change. Every
 * job_index row written before it has no cost field, so jobs added to an RO
 * from that older history still fall back to the per-shop ratio estimate.
 *
 * Strategy
 * --------
 * Stream the already-imported `normalized_work_orders` (Protractor only) and,
 * for each stored raw invoice payload:
 *   1. Re-run the LIVE extractor (`extractJobIndexFromWorkOrder`) so cost
 *      capture is byte-for-byte identical to what a fresh index would write.
 *   2. Look up the existing job_index rows by (shopId, workOrderId) — an
 *      indexed query — and patch ONLY the missing `cost` / `extendedCost`
 *      fields onto matching lines. No rows are created, nothing else on the
 *      row is rewritten, and lines that already carry a cost are left alone.
 *   3. Recompute `contentHash` from the patched row so the next backfill pass
 *      doesn't see a spurious "changed" row and rewrite it again.
 *   4. Optionally (`--normalized`) replay service jobs + line items through
 *      the normal ingestion path so `normalized_line_items` (+ PG dual-write)
 *      pick up cost too — same replay path as backfill-protractor-history-dates.
 *
 * SAFETY — this is a PRODUCTION data operation
 * --------------------------------------------
 * The dev Mongo cluster for this repl IS the production cluster, and an
 * aggressive sweep is a known cause of shared-Mongo saturation (fleet-wide
 * login/cron timeouts). Therefore:
 *   - DEFAULTS TO DRY RUN: reads + reports what WOULD be patched; writes only
 *     with an explicit `--confirm`.
 *   - PACED: configurable sleep between batches (`--sleep`, default 500ms).
 *     Run OFF-HOURS and watch Mongo load.
 *   - Protractor-ONLY (provenance.sourceSystem === 'protractor'); Tekmetric /
 *     Shop-Ware rows are never touched.
 *   - RESUMABLE via .local/backfill-protractor-part-costs-checkpoint.json
 *     (dry and live runs keep separate checkpoint namespaces).
 *   - The `--normalized` replay is opt-in because it adds PG + Mongo write
 *     load per WO; run the job_index-only pass first.
 *
 * Usage
 * -----
 *   tsx scripts/backfill-protractor-part-costs.ts                    # DRY RUN, all protractor shops
 *   tsx scripts/backfill-protractor-part-costs.ts --shop=54          # DRY RUN, one shop
 *   tsx scripts/backfill-protractor-part-costs.ts --confirm          # LIVE write
 *   tsx scripts/backfill-protractor-part-costs.ts --confirm --normalized  # also replay normalized line items
 *   tsx scripts/backfill-protractor-part-costs.ts --batch=50         # default 50
 *   tsx scripts/backfill-protractor-part-costs.ts --sleep=500        # ms between batches, default 500
 *   tsx scripts/backfill-protractor-part-costs.ts --limit=1000       # stop after N WOs (then re-run)
 *   tsx scripts/backfill-protractor-part-costs.ts --reset            # discard checkpoint
 */

import fs from "node:fs";
import path from "node:path";
import { getDb as getMongoDb } from "../lib/mongo";
import {
  extractJobIndexFromWorkOrder,
  computeJobHash,
  type JobIndexEntry,
} from "../lib/job-index";
import { NormalizedIngestionService } from "../lib/integrations/core/normalized-ingestion";
import type { SourceSystem } from "../lib/normalized-schema";

const PROTRACTOR: SourceSystem = "protractor";

interface Args {
  shop?: number;
  batch: number;
  sleepMs: number;
  reset: boolean;
  confirm: boolean;
  normalized: boolean;
  limit?: number;
}

/**
 * Parse a required-positive-integer CLI value, exiting on anything invalid
 * (NaN / negative / non-integer) so a typo can't silently turn into a giant or
 * zero batch against production.
 */
function posInt(flag: string, v: string | undefined, { allowZero = false } = {}): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) {
    console.error(
      `Invalid value for --${flag}: ${JSON.stringify(v)} (expected a ${allowZero ? "non-negative" : "positive"} integer)`,
    );
    process.exit(1);
  }
  return n;
}

function parseArgs(): Args {
  const out: Args = {
    batch: 50,
    sleepMs: 500,
    reset: false,
    confirm: false,
    normalized: false,
  };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    switch (k) {
      case "shop": out.shop = posInt("shop", v); break;
      case "batch": out.batch = posInt("batch", v); break;
      case "sleep": out.sleepMs = posInt("sleep", v, { allowZero: true }); break;
      case "limit": out.limit = posInt("limit", v); break;
      case "reset": out.reset = true; break;
      case "confirm": out.confirm = true; break;
      case "normalized": out.normalized = true; break;
      default: console.warn(`Unknown arg: --${k}`);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHECKPOINT_DIR = path.join(process.cwd(), ".local");
const CHECKPOINT_FILE = path.join(
  CHECKPOINT_DIR,
  "backfill-protractor-part-costs-checkpoint.json",
);

interface CheckpointEntry {
  lastId: string | null;
  processed: number;
  /** WOs whose stored payload had no raw invoice to re-extract from. */
  skippedNoRaw: number;
  /** WOs whose raw payload carries no real cost on any line. */
  noCostInRaw: number;
  /** WOs with cost in raw but no matching job_index rows at all. */
  noJobRows: number;
  /** job_index rows already fully costed (nothing to do). */
  rowsAlreadyCosted: number;
  /** job_index rows whose servicePackageId had no match in the re-extraction. */
  rowsNoPkgMatch: number;
  /** rows needing cost whose raw package/lines carry no usable cost to give. */
  rowsNoCostAvail: number;
  /** job_index rows patched (or that WOULD be patched in dry run). */
  rowsPatched: number;
  /** individual line items that gained cost/extendedCost. */
  linesPatched: number;
  errors: number;
  /** --normalized replay counters (live only). */
  normalizedServiceJobs: number;
  normalizedLineItems: number;
  finishedAt?: string;
}

type Checkpoint = Record<string, CheckpointEntry>;

function loadCheckpoint(): Checkpoint {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8")); } catch { return {}; }
}

function saveCheckpoint(cp: Checkpoint): void {
  if (!fs.existsSync(CHECKPOINT_DIR)) fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

/**
 * Dry-run and live runs keep SEPARATE checkpoint namespaces: the normal
 * operator sequence — dry run to preview, then re-run with --confirm — must
 * not resume the live run past rows the dry run merely analyzed.
 */
function checkpointKey(shop: number | undefined, live: boolean) {
  const scope = shop != null ? `shop=${shop}` : "all";
  return `${live ? "live" : "dry"}:${scope}`;
}

function newEntry(): CheckpointEntry {
  return {
    lastId: null,
    processed: 0,
    skippedNoRaw: 0,
    noCostInRaw: 0,
    noJobRows: 0,
    rowsAlreadyCosted: 0,
    rowsNoPkgMatch: 0,
    rowsNoCostAvail: 0,
    rowsPatched: 0,
    linesPatched: 0,
    errors: 0,
    normalizedServiceJobs: 0,
    normalizedLineItems: 0,
  };
}

/** A stored/extracted job line needs cost iff it's non-labor without a positive cost. */
function lineNeedsCost(line: any): boolean {
  if (!line || line.lineType === "labor") return false;
  return !(typeof line.cost === "number" && Number.isFinite(line.cost) && line.cost > 0);
}

function lineHasCost(line: any): boolean {
  return (
    (typeof line?.cost === "number" && Number.isFinite(line.cost) && line.cost > 0) ||
    (typeof line?.extendedCost === "number" && Number.isFinite(line.extendedCost) && line.extendedCost > 0)
  );
}

/**
 * Identity key for matching a stored job_index line to its re-extracted twin.
 * Both sides were produced by the SAME extractor, so descriptions/types align;
 * price is deliberately excluded (list-vs-detail float noise) — a part's
 * identity is its type + description + part number + quantity.
 */
function lineKey(line: any): string {
  const desc = String(line?.description ?? "").trim().toLowerCase();
  const pn = String(line?.partNumber ?? "").trim().toUpperCase();
  const qty = Math.round((Number(line?.quantity) || 1) * 1000) / 1000;
  return `${line?.lineType}|${desc}|${pn}|${qty}`;
}

/**
 * Patch missing cost/extendedCost onto a stored job_index row's lines from a
 * re-extracted entry. Returns the patched lines array and how many lines
 * changed — or null when nothing changed. Duplicate lines (same key) are
 * consumed in order so two identical parts each get their own cost.
 */
function patchLines(
  storedLines: any[],
  extractedLines: JobIndexEntry["lines"],
): { lines: any[]; patched: number } | null {
  const pool = new Map<string, any[]>();
  for (const el of extractedLines) {
    if (!lineHasCost(el)) continue;
    const k = lineKey(el);
    const arr = pool.get(k);
    if (arr) arr.push(el);
    else pool.set(k, [el]);
  }
  if (pool.size === 0) return null;

  let patched = 0;
  const out = storedLines.map((sl) => {
    if (!lineNeedsCost(sl)) return sl;
    const candidates = pool.get(lineKey(sl));
    const match = candidates?.shift();
    if (!match) return sl;
    const next = { ...sl };
    if (typeof match.cost === "number" && match.cost > 0) next.cost = match.cost;
    if (typeof match.extendedCost === "number" && match.extendedCost > 0) {
      next.extendedCost = match.extendedCost;
    }
    if (next.cost === sl.cost && next.extendedCost === sl.extendedCost) return sl;
    patched++;
    return next;
  });

  return patched > 0 ? { lines: out, patched } : null;
}

/**
 * Cache of per-shop ingestion services for the opt-in `--normalized` replay.
 * `forceUpdate` is intentionally OFF: cost now participates in the mapped
 * content, so rows that genuinely gain cost hash differently and update,
 * while already-costed rows skip cheaply.
 */
const serviceCache = new Map<number, NormalizedIngestionService>();
function getService(db: any, shopId: number, enterpriseId?: string): NormalizedIngestionService {
  let svc = serviceCache.get(shopId);
  if (!svc) {
    svc = new NormalizedIngestionService(db, PROTRACTOR, shopId, enterpriseId, {
      dualWriteToJobIndex: false,
      dualWriteToRepairPatterns: false,
      dualWriteToSupabase: true,
      ingestionVia: "backfill",
      createAuditLog: false,
    });
    serviceCache.set(shopId, svc);
  }
  return svc;
}

async function main() {
  const args = parseArgs();
  const live = args.confirm;

  console.log(
    `[backfill-protractor-part-costs] mode=${live ? "LIVE" : "DRY RUN"} ` +
      `batch=${args.batch} sleep=${args.sleepMs}ms normalized=${args.normalized}` +
      (args.shop != null ? ` shop=${args.shop}` : " (all protractor shops)") +
      (args.limit != null ? ` limit=${args.limit}` : ""),
  );
  if (!live) {
    console.log(
      "  >>> DRY RUN: reads + reports only, no writes. Re-run with --confirm to apply. " +
        "This is a PRODUCTION operation — run OFF-HOURS and watch Mongo load.",
    );
  }
  if (args.normalized && !live) {
    console.log("  >>> --normalized has no effect in dry run (replay only happens on --confirm).");
  }

  const cpAll = loadCheckpoint();
  const key = checkpointKey(args.shop, live);
  console.log(`  checkpoint namespace: ${key} (dry & live tracked separately)`);
  if (args.reset) delete cpAll[key];
  const cp: CheckpointEntry = cpAll[key] ?? newEntry();

  const db = await getMongoDb();
  const woColl = db.collection("normalized_work_orders");
  const jobIndex = db.collection("job_index");

  // Protractor-only. Tekmetric / Shop-Ware rows are never touched.
  const filter: Record<string, any> = { "provenance.sourceSystem": PROTRACTOR };
  if (args.shop != null) filter.shopId = args.shop;
  if (cp.lastId) filter._id = { $gt: cp.lastId };

  const total = await woColl.countDocuments(filter);
  console.log(
    `  ${total.toLocaleString()} protractor work orders to scan` +
      (cp.lastId ? ` (resuming from _id > ${cp.lastId})` : ""),
  );
  if (total === 0) {
    cp.finishedAt = new Date().toISOString();
    cpAll[key] = cp;
    saveCheckpoint(cpAll);
    return;
  }

  const cursor = woColl
    .find(filter)
    .sort({ _id: 1 })
    .project({ shopId: 1, enterpriseId: 1, rawPayload: 1 })
    .batchSize(args.batch);
  const startedAt = Date.now();
  let buffer: any[] = [];
  let limitReached = false;

  const processOne = async (wo: any) => {
    const rawPayload = wo?.rawPayload;
    if (!rawPayload || typeof rawPayload !== "object") {
      cp.skippedNoRaw++;
      return;
    }

    // 1. Re-run the LIVE extractor so cost capture matches a fresh index.
    const entries = extractJobIndexFromWorkOrder(wo.shopId, rawPayload, "protractor");
    const costEntries = entries.filter((e) => e.lines.some(lineHasCost));
    if (costEntries.length === 0) {
      cp.noCostInRaw++;
      return;
    }

    // 2. Indexed lookup of the existing rows for this WO.
    const workOrderId = costEntries[0].workOrderId;
    const jobRows = await jobIndex
      .find({ shopId: wo.shopId, workOrderId })
      .project({ lines: 1, servicePackageId: 1, workOrderId: 1, vehicle: 1, job: 1, totals: 1 })
      .toArray();
    if (jobRows.length === 0) {
      cp.noJobRows++;
      return;
    }

    // Map ALL extracted packages (not just cost-bearing ones) so a row whose
    // package genuinely has no cost in the raw payload is counted as
    // "no cost available", not as a package mismatch.
    const byPkg = new Map<string, JobIndexEntry>();
    for (const e of entries) byPkg.set(String(e.servicePackageId), e);

    let woPatchedRows = 0;
    for (const row of jobRows) {
      const storedLines = Array.isArray(row.lines) ? row.lines : [];
      if (!storedLines.some(lineNeedsCost)) {
        cp.rowsAlreadyCosted++;
        continue;
      }
      const entry = byPkg.get(String(row.servicePackageId));
      if (!entry) {
        cp.rowsNoPkgMatch++;
        continue;
      }
      const patch = patchLines(storedLines, entry.lines);
      if (!patch) {
        cp.rowsNoCostAvail++;
        continue;
      }

      cp.rowsPatched++;
      cp.linesPatched += patch.patched;
      woPatchedRows++;

      if (live) {
        // 3. Recompute the content hash from the PATCHED stored row (hash only
        //    reads workOrderId/servicePackageId/vehicle/job/lines/totals) so
        //    the next re-index pass doesn't flag a spurious change.
        const contentHash = computeJobHash({ ...(row as any), lines: patch.lines });
        await jobIndex.updateOne(
          { _id: row._id },
          { $set: { lines: patch.lines, contentHash } },
        );
      }
    }

    // 4. Opt-in normalized replay so normalized_line_items (+ PG) gain cost too.
    if (live && args.normalized && woPatchedRows > 0) {
      const svc = getService(db, wo.shopId, wo.enterpriseId);
      const replay = await svc.replayServiceJobsAndLineItemsFromRawPayload(
        String(wo._id),
        rawPayload,
      );
      cp.normalizedServiceJobs += replay.serviceJobs.filter(
        (r) => r.action === "created" || r.action === "updated",
      ).length;
      cp.normalizedLineItems += replay.lineItems.filter(
        (r) => r.action === "created" || r.action === "updated",
      ).length;
    }
  };

  const flush = async () => {
    if (!buffer.length) return;

    let lastProcessedId: string | null = null;
    for (const wo of buffer) {
      if (args.limit != null && cp.processed >= args.limit) {
        limitReached = true;
        break;
      }
      try {
        await processOne(wo);
      } catch (err: any) {
        cp.errors++;
        if (cp.errors <= 5) {
          console.error(`  WO ${wo._id} failed:`, err?.message || err);
        }
      }
      cp.processed++;
      lastProcessedId = String(wo._id);
    }

    // Only advance lastId to the last *actually processed* doc so a --limit
    // short-circuit re-fetches the unprocessed tail on the next run.
    if (lastProcessedId) cp.lastId = lastProcessedId;
    cpAll[key] = cp;
    saveCheckpoint(cpAll);

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = cp.processed / Math.max(elapsed, 1);
    const eta = Math.max(0, (total - cp.processed) / Math.max(rate, 1));
    console.log(
      `  processed=${cp.processed.toLocaleString()}/${total.toLocaleString()} ` +
        `rowsPatched=${cp.rowsPatched} linesPatched=${cp.linesPatched} ` +
        `alreadyCosted=${cp.rowsAlreadyCosted} noCostInRaw=${cp.noCostInRaw} ` +
        `noCostAvail=${cp.rowsNoCostAvail} noJobRows=${cp.noJobRows} ` +
        `noPkgMatch=${cp.rowsNoPkgMatch} noRaw=${cp.skippedNoRaw} err=${cp.errors}` +
        (args.normalized && live
          ? ` normSJ=${cp.normalizedServiceJobs} normLI=${cp.normalizedLineItems}`
          : "") +
        ` rate=${rate.toFixed(1)}/s eta=${Math.round(eta)}s`,
    );
    buffer = [];
  };

  for await (const doc of cursor) {
    buffer.push(doc);
    if (buffer.length >= args.batch) {
      await flush();
      if (limitReached) break;
      // Pace between batches so shared Mongo never saturates.
      if (args.sleepMs > 0) await sleep(args.sleepMs);
    }
  }
  if (!limitReached) await flush();

  cp.finishedAt = new Date().toISOString();
  cpAll[key] = cp;
  saveCheckpoint(cpAll);
  console.log(
    `[backfill-protractor-part-costs] DONE (${live ? "LIVE" : "DRY RUN"}) — ` +
      `processed=${cp.processed.toLocaleString()} ` +
      `rowsPatched=${cp.rowsPatched} linesPatched=${cp.linesPatched} ` +
      `alreadyCosted=${cp.rowsAlreadyCosted} noCostInRaw=${cp.noCostInRaw} ` +
      `noCostAvail=${cp.rowsNoCostAvail} noJobRows=${cp.noJobRows} ` +
      `noPkgMatch=${cp.rowsNoPkgMatch} noRaw=${cp.skippedNoRaw} errors=${cp.errors}` +
      (args.normalized && live
        ? ` normalizedSJ=${cp.normalizedServiceJobs} normalizedLI=${cp.normalizedLineItems}`
        : "") +
      (limitReached ? " [LIMIT REACHED — re-run to continue]" : ""),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
