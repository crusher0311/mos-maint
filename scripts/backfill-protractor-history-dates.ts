/**
 * Task #641 backfill: fill REAL business/history dates into already-imported
 * Protractor work orders + service jobs.
 *
 * Background
 * ----------
 * Task #640 fixed the Protractor normalized adapter (mapWorkOrder /
 * mapServiceJob date sources) and the PG dual-writer (upsertServiceJob now
 * persists `completedAt`). But that fix only affects records as they are
 * *newly ingested or updated*. Every Protractor row imported BEFORE the fix
 * still has empty date columns:
 *   - normalized_work_orders.closed_date / completed_date / check_in_date
 *   - normalized_service_jobs.completed_at
 * Until those backfill, Settings → Integrations "Data Status" keeps showing
 * the MOS import date instead of true history for Protractor shops.
 *
 * Strategy
 * --------
 * Stream the already-imported `normalized_work_orders` (Protractor only) from
 * Mongo and, for each one, replay the EXACT live ingestion code paths off the
 * stored raw payload:
 *   1. `ingestWorkOrder(rawPayload)` with `forceUpdate` — re-maps the work
 *      order so closed_date / completed_date / check_in_date land (the adapter
 *      now reads InvoiceTime / Header.* instead of the never-present top-level
 *      fields). Re-upserts the WO row in PG (+ Mongo shadow when enabled).
 *   2. `replayServiceJobsAndLineItemsFromRawPayload(woId, rawPayload)` — the
 *      same path scripts/backfill-service-jobs.ts uses; re-maps each service
 *      job so `completed_at` lands (the adapter stamps the parent invoice's
 *      close date onto packages with no date of their own).
 *
 * SAFETY — this is a PRODUCTION data operation
 * --------------------------------------------
 * The dev Mongo cluster for this repl IS the production cluster, and an
 * aggressive re-normalize is a known cause of shared-Mongo saturation that
 * has previously taken down logins / cron fleet-wide. Therefore:
 *   - The script DEFAULTS TO DRY RUN. It will only write when `--confirm` is
 *     passed explicitly.
 *   - It is PACED: a configurable sleep runs between every batch (`--sleep`,
 *     default 500ms) so it never hammers shared Mongo. Run it OFF-HOURS.
 *   - It is Protractor-ONLY (filters provenance.sourceSystem === 'protractor').
 *     Tekmetric / Shop-Ware rows are never touched.
 *   - It is RESUMABLE via .local/backfill-protractor-history-dates-checkpoint.json
 *     so an interrupted run continues without re-scanning processed rows.
 *
 * Usage
 * -----
 *   tsx scripts/backfill-protractor-history-dates.ts                  # DRY RUN, all protractor shops
 *   tsx scripts/backfill-protractor-history-dates.ts --shop=54        # DRY RUN, one shop
 *   tsx scripts/backfill-protractor-history-dates.ts --confirm        # LIVE write, all protractor shops
 *   tsx scripts/backfill-protractor-history-dates.ts --shop=54 --confirm
 *   tsx scripts/backfill-protractor-history-dates.ts --batch=50       # default 50
 *   tsx scripts/backfill-protractor-history-dates.ts --sleep=500      # ms between batches, default 500
 *   tsx scripts/backfill-protractor-history-dates.ts --limit=1000     # stop after N WOs (then re-run)
 *   tsx scripts/backfill-protractor-history-dates.ts --reset          # discard checkpoint
 */

import fs from "node:fs";
import path from "node:path";
import { getDb as getMongoDb } from "../lib/mongo";
import { NormalizedIngestionService } from "../lib/integrations/core/normalized-ingestion";
import type { IngestionResult } from "../lib/integrations/core/normalized-ingestion";
import type { SourceSystem } from "../lib/normalized-schema";

const PROTRACTOR: SourceSystem = "protractor";

interface Args {
  shop?: number;
  batch: number;
  sleepMs: number;
  reset: boolean;
  confirm: boolean;
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
    console.error(`Invalid value for --${flag}: ${JSON.stringify(v)} (expected a ${allowZero ? "non-negative" : "positive"} integer)`);
    process.exit(1);
  }
  return n;
}

function parseArgs(): Args {
  const out: Args = { batch: 50, sleepMs: 500, reset: false, confirm: false };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    switch (k) {
      case "shop": out.shop = posInt("shop", v); break;
      case "batch": out.batch = posInt("batch", v); break;
      case "sleep": out.sleepMs = posInt("sleep", v, { allowZero: true }); break;
      case "limit": out.limit = posInt("limit", v); break;
      case "reset": out.reset = true; break;
      case "confirm": out.confirm = true; break;
      default: console.warn(`Unknown arg: --${k}`);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CHECKPOINT_DIR = path.join(process.cwd(), ".local");
const CHECKPOINT_FILE = path.join(
  CHECKPOINT_DIR,
  "backfill-protractor-history-dates-checkpoint.json",
);

interface ActionCounter {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

interface CheckpointEntry {
  lastId: string | null;
  processed: number;
  workOrders: ActionCounter;
  serviceJobs: ActionCounter;
  lineItems: ActionCounter;
  skippedNoRaw: number;
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
 * Dry-run and live runs keep SEPARATE checkpoint namespaces. The script
 * defaults to dry run, so without this a normal operator sequence — run once to
 * preview, then re-run with --confirm — would resume the live run past rows the
 * dry run merely "visited", silently skipping their writes. Namespacing by mode
 * means a dry run never advances the live cursor.
 */
function checkpointKey(shop: number | undefined, live: boolean) {
  const scope = shop != null ? `shop=${shop}` : "all";
  return `${live ? "live" : "dry"}:${scope}`;
}

function newCounter(): ActionCounter {
  return { created: 0, updated: 0, skipped: 0, errors: 0 };
}

function bumpCounter(counter: ActionCounter, action: IngestionResult["action"]): void {
  switch (action) {
    case "created": counter.created++; break;
    case "updated": counter.updated++; break;
    case "skipped": counter.skipped++; break;
    case "error":   counter.errors++; break;
  }
}

/**
 * Cache of per-shop ingestion services. NIS holds a per-shop dual-writer +
 * adapter, so we memoize one per shop. `forceUpdate` guarantees the work
 * order re-maps even if the (now-changed) content hash happened to match.
 * Derived collections (job_index / repair_patterns / audit) are intentionally
 * left untouched — this backfill is only about the normalized date columns —
 * which also keeps Mongo load down.
 */
const serviceCache = new Map<number, NormalizedIngestionService>();
function getService(db: any, shopId: number, enterpriseId?: string): NormalizedIngestionService {
  let svc = serviceCache.get(shopId);
  if (!svc) {
    svc = new NormalizedIngestionService(db, PROTRACTOR, shopId, enterpriseId, {
      forceUpdate: true,
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
    `[backfill-protractor-history-dates] mode=${live ? "LIVE" : "DRY RUN"} ` +
      `batch=${args.batch} sleep=${args.sleepMs}ms` +
      (args.shop != null ? ` shop=${args.shop}` : " (all protractor shops)") +
      (args.limit != null ? ` limit=${args.limit}` : ""),
  );
  if (!live) {
    console.log(
      "  >>> DRY RUN: no writes. Re-run with --confirm to apply. " +
        "This is a PRODUCTION operation — run OFF-HOURS and watch Mongo load.",
    );
  }

  const cpAll = loadCheckpoint();
  const key = checkpointKey(args.shop, live);
  console.log(`  checkpoint namespace: ${key} (dry & live tracked separately)`);
  if (args.reset) delete cpAll[key];
  const cp: CheckpointEntry = cpAll[key] ?? {
    lastId: null,
    processed: 0,
    workOrders: newCounter(),
    serviceJobs: newCounter(),
    lineItems: newCounter(),
    skippedNoRaw: 0,
  };

  const db = await getMongoDb();
  const woColl = db.collection("normalized_work_orders");

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

  const cursor = woColl.find(filter).sort({ _id: 1 }).batchSize(args.batch);
  const startedAt = Date.now();
  let buffer: any[] = [];
  let limitReached = false;

  const flush = async () => {
    if (!buffer.length) return;

    if (!live) {
      // Dry run: advance the cursor only, so switching to --confirm later
      // does not skip rows we never actually processed.
      const remaining = args.limit != null ? args.limit - cp.processed : buffer.length;
      const visit = Math.max(0, Math.min(buffer.length, remaining));
      if (visit > 0) {
        cp.processed += visit;
        cp.lastId = String(buffer[visit - 1]._id);
      }
      if (args.limit != null && cp.processed >= args.limit) limitReached = true;
      buffer = [];
      return;
    }

    let lastProcessedId: string | null = null;
    for (const wo of buffer) {
      if (args.limit != null && cp.processed >= args.limit) {
        limitReached = true;
        break;
      }
      try {
        const rawPayload = wo?.rawPayload;
        if (!rawPayload || typeof rawPayload !== "object") {
          cp.skippedNoRaw++;
        } else {
          const svc = getService(db, wo.shopId, wo.enterpriseId);
          // 1. Re-ingest the work order → fills closed_date / completed_date /
          //    check_in_date from the stored raw invoice payload.
          const woRes = await svc.ingestWorkOrder(rawPayload);
          bumpCounter(cp.workOrders, woRes.action);
          // 2. Replay service jobs + line items → fills service_jobs.completed_at.
          const replay = await svc.replayServiceJobsAndLineItemsFromRawPayload(
            String(wo._id),
            rawPayload,
          );
          for (const sj of replay.serviceJobs) bumpCounter(cp.serviceJobs, sj.action);
          for (const li of replay.lineItems) bumpCounter(cp.lineItems, li.action);
        }
      } catch (err: any) {
        cp.workOrders.errors++;
        if (cp.workOrders.errors <= 5) {
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
        `wo=${cp.workOrders.created}c/${cp.workOrders.updated}u/${cp.workOrders.skipped}s/${cp.workOrders.errors}e ` +
        `sj=${cp.serviceJobs.created}c/${cp.serviceJobs.updated}u/${cp.serviceJobs.skipped}s/${cp.serviceJobs.errors}e ` +
        `li=${cp.lineItems.created}c/${cp.lineItems.updated}u/${cp.lineItems.skipped}s/${cp.lineItems.errors}e ` +
        `noRaw=${cp.skippedNoRaw} rate=${rate.toFixed(1)}/s eta=${Math.round(eta)}s`,
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
    `[backfill-protractor-history-dates] DONE (${live ? "LIVE" : "DRY RUN"}) — ` +
      `processed=${cp.processed.toLocaleString()} ` +
      `wo(c/u/s/e)=${cp.workOrders.created}/${cp.workOrders.updated}/${cp.workOrders.skipped}/${cp.workOrders.errors} ` +
      `sj(c/u/s/e)=${cp.serviceJobs.created}/${cp.serviceJobs.updated}/${cp.serviceJobs.skipped}/${cp.serviceJobs.errors} ` +
      `li(c/u/s/e)=${cp.lineItems.created}/${cp.lineItems.updated}/${cp.lineItems.skipped}/${cp.lineItems.errors} ` +
      `skippedNoRaw=${cp.skippedNoRaw}` +
      (limitReached ? " [LIMIT REACHED — re-run to continue]" : ""),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
