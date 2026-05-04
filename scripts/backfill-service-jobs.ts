/**
 * Task #360 backfill: populate `normalized_service_jobs` and
 * `normalized_line_items` (Mongo + PG via dual-write) from the existing
 * ~552K `normalized_work_orders` docs that were ingested before
 * `ingestServiceJob` / `ingestLineItem` were wired into the pipeline.
 *
 * Strategy: iterate each work order and call
 * `NormalizedIngestionService.replayServiceJobsAndLineItemsFromRawPayload`,
 * which is the exact code path the live ingestion now takes for service
 * jobs + line items, minus the work-order upsert (the WO doc is already
 * correct in PG).
 *
 * Resumable via `.local/backfill-service-jobs-checkpoint.json`, scoped by
 * `--shop=<shopId>` (or `:all`). The checkpoint advances strictly to the
 * last *processed* work-order `_id`, so `--limit` short-circuits do not
 * skip unprocessed docs on the next run.
 *
 * Usage:
 *   tsx scripts/backfill-service-jobs.ts                    # all shops
 *   tsx scripts/backfill-service-jobs.ts --shop=54
 *   tsx scripts/backfill-service-jobs.ts --batch=200        # default 100
 *   tsx scripts/backfill-service-jobs.ts --reset            # discard checkpoint
 *   tsx scripts/backfill-service-jobs.ts --dry-run          # iterate only
 *   tsx scripts/backfill-service-jobs.ts --limit=1000       # stop after N WOs
 */

import fs from "node:fs";
import path from "node:path";
import { getDb as getMongoDb } from "../lib/mongo";
import { NormalizedIngestionService } from "../lib/integrations/core/normalized-ingestion";
import type { IngestionResult } from "../lib/integrations/core/normalized-ingestion";
import type { SourceSystem } from "../lib/normalized-schema";

interface Args {
  shop?: number;
  batch: number;
  reset: boolean;
  dryRun: boolean;
  limit?: number;
}

function parseArgs(): Args {
  const out: Args = { batch: 100, reset: false, dryRun: false };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    switch (k) {
      case "shop": out.shop = Number(v); break;
      case "batch": out.batch = Number(v); break;
      case "reset": out.reset = true; break;
      case "dry-run": out.dryRun = true; break;
      case "limit": out.limit = Number(v); break;
      default: console.warn(`Unknown arg: --${k}`);
    }
  }
  return out;
}

const CHECKPOINT_DIR = path.join(process.cwd(), ".local");
const CHECKPOINT_FILE = path.join(
  CHECKPOINT_DIR,
  "backfill-service-jobs-checkpoint.json",
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
  serviceJobs: ActionCounter;
  lineItems: ActionCounter;
  skippedNoRaw: number;
  skippedNoSource: number;
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

function checkpointKey(shop?: number) {
  return shop != null ? `shop=${shop}` : "all";
}

/**
 * IngestionResult.action is a closed string union. Mapping it to the
 * ActionCounter slot keeps both sides type-checked (no `as any` index).
 */
function bumpCounter(counter: ActionCounter, action: IngestionResult["action"]): void {
  switch (action) {
    case "created": counter.created++; break;
    case "updated": counter.updated++; break;
    case "skipped": counter.skipped++; break;
    case "error":   counter.errors++; break;
  }
}

/**
 * Cache of per-(shopId, sourceSystem) ingestion services. NIS holds a
 * per-shop dual-writer + adapter, so we memoize one per pair.
 */
const serviceCache = new Map<string, NormalizedIngestionService>();
async function getService(
  db: any,
  shopId: number,
  sourceSystem: SourceSystem,
  enterpriseId?: string,
): Promise<NormalizedIngestionService> {
  const key = `${shopId}:${sourceSystem}`;
  let svc = serviceCache.get(key);
  if (!svc) {
    svc = new NormalizedIngestionService(db, sourceSystem, shopId, enterpriseId, {
      // Backfill should not re-touch derived collections — those are already
      // in sync with the live ingestion path. We only want service jobs +
      // line items written to Mongo + PG.
      dualWriteToJobIndex: false,
      dualWriteToRepairPatterns: false,
      dualWriteToSupabase: true,
      ingestionVia: "backfill",
      createAuditLog: false,
    });
    serviceCache.set(key, svc);
  }
  return svc;
}

async function main() {
  const args = parseArgs();
  const cpAll = loadCheckpoint();
  const key = checkpointKey(args.shop);
  if (args.reset) delete cpAll[key];
  const cp: CheckpointEntry = cpAll[key] ?? {
    lastId: null,
    processed: 0,
    serviceJobs: { created: 0, updated: 0, skipped: 0, errors: 0 },
    lineItems: { created: 0, updated: 0, skipped: 0, errors: 0 },
    skippedNoRaw: 0,
    skippedNoSource: 0,
  };

  const db = await getMongoDb();
  const woColl = db.collection("normalized_work_orders");

  const filter: Record<string, any> = {};
  if (args.shop != null) filter.shopId = args.shop;
  if (cp.lastId) filter._id = { $gt: cp.lastId };

  const total = await woColl.countDocuments(filter);
  console.log(
    `[backfill-service-jobs] ${total.toLocaleString()} work orders to scan` +
      (cp.lastId ? ` (resuming from _id > ${cp.lastId})` : "") +
      (args.shop != null ? ` (shop=${args.shop})` : "") +
      (args.dryRun ? " [DRY RUN]" : ""),
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
    if (args.dryRun) {
      // Dry run: still advance to last actually visited doc and respect limit
      // so re-runs don't reprocess them when switching off --dry-run.
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
        const sourceSystem = wo?.provenance?.sourceSystem as SourceSystem | undefined;
        const rawPayload = wo?.rawPayload;
        if (!sourceSystem) {
          cp.skippedNoSource++;
        } else if (!rawPayload || typeof rawPayload !== "object") {
          cp.skippedNoRaw++;
        } else {
          const svc = await getService(db, wo.shopId, sourceSystem, wo.enterpriseId);
          const replay = await svc.replayServiceJobsAndLineItemsFromRawPayload(
            String(wo._id),
            rawPayload,
          );
          for (const sj of replay.serviceJobs) bumpCounter(cp.serviceJobs, sj.action);
          for (const li of replay.lineItems) bumpCounter(cp.lineItems, li.action);
        }
      } catch (err: any) {
        cp.serviceJobs.errors++;
        if (cp.serviceJobs.errors <= 5) {
          console.error(`  WO ${wo._id} failed:`, err?.message || err);
        }
      }
      cp.processed++;
      lastProcessedId = String(wo._id);
    }
    // Critical: only advance lastId to the last *actually processed* doc.
    // If --limit short-circuited the loop, the unprocessed tail of `buffer`
    // must be re-fetched on the next run.
    if (lastProcessedId) cp.lastId = lastProcessedId;
    cpAll[key] = cp;
    saveCheckpoint(cpAll);

    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = cp.processed / Math.max(elapsed, 1);
    const eta = Math.max(0, (total - cp.processed) / Math.max(rate, 1));
    console.log(
      `  processed=${cp.processed.toLocaleString()}/${total.toLocaleString()} ` +
        `sj=${cp.serviceJobs.created}c/${cp.serviceJobs.updated}u/${cp.serviceJobs.skipped}s/${cp.serviceJobs.errors}e ` +
        `li=${cp.lineItems.created}c/${cp.lineItems.updated}u/${cp.lineItems.skipped}s/${cp.lineItems.errors}e ` +
        `noRaw=${cp.skippedNoRaw} noSrc=${cp.skippedNoSource} ` +
        `rate=${rate.toFixed(1)}/s eta=${Math.round(eta)}s`,
    );
    buffer = [];
  };

  for await (const doc of cursor) {
    buffer.push(doc);
    if (buffer.length >= args.batch) {
      await flush();
      if (limitReached) break;
    }
  }
  if (!limitReached) await flush();

  cp.finishedAt = new Date().toISOString();
  cpAll[key] = cp;
  saveCheckpoint(cpAll);
  console.log(
    `[backfill-service-jobs] DONE — processed=${cp.processed.toLocaleString()} ` +
      `serviceJobs(c/u/s/e)=${cp.serviceJobs.created}/${cp.serviceJobs.updated}/${cp.serviceJobs.skipped}/${cp.serviceJobs.errors} ` +
      `lineItems(c/u/s/e)=${cp.lineItems.created}/${cp.lineItems.updated}/${cp.lineItems.skipped}/${cp.lineItems.errors} ` +
      `skippedNoRaw=${cp.skippedNoRaw} skippedNoSource=${cp.skippedNoSource}` +
      (limitReached ? " [LIMIT REACHED — re-run to continue]" : ""),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
