/**
 * Backfill Mongo → Supabase for the 6 dual-written normalized collections.
 *
 * Reuses lib/supabase-dual-writer.ts so field mappings stay in sync with
 * the live ingestion path.
 *
 * Usage:
 *   tsx scripts/backfill-mongo-to-supabase.ts                       # all collections, all shops
 *   tsx scripts/backfill-mongo-to-supabase.ts --collection=vehicles # single collection
 *   tsx scripts/backfill-mongo-to-supabase.ts --shop=54             # single shop (numeric mosShopId)
 *   tsx scripts/backfill-mongo-to-supabase.ts --batch=500           # batch size (default 250)
 *   tsx scripts/backfill-mongo-to-supabase.ts --concurrency=4       # parallel upserts per batch (default 4)
 *   tsx scripts/backfill-mongo-to-supabase.ts --reset                # discard checkpoint and start over
 *   tsx scripts/backfill-mongo-to-supabase.ts --verify-only          # skip backfill, just print row-count diffs
 *   tsx scripts/backfill-mongo-to-supabase.ts --dry-run              # iterate Mongo but do not write to Supabase
 *
 * Resumable: checkpoint stored in .local/backfill-checkpoint.json keyed by
 * (collection, shopFilter). Each batch advances the checkpoint to the last
 * processed _id, so a re-run picks up where it left off.
 */

import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { getDb as getMongoDb } from "../lib/mongo";
import { getDb as getPgDb } from "../lib/db/drizzle";
import { SupabaseDualWriter } from "../lib/supabase-dual-writer";
import {
  normalizedVehicles,
  normalizedCustomers,
  normalizedWorkOrders,
  normalizedServiceJobs,
  normalizedLineItems,
  normalizedPayments,
} from "../lib/db/schema/normalized";

type CollectionKey =
  | "vehicles"
  | "customers"
  | "work_orders"
  | "service_jobs"
  | "line_items"
  | "payments";

interface CollectionSpec {
  key: CollectionKey;
  mongoName: string;
  pgTable: any;
  upsert: (writer: SupabaseDualWriter, doc: any) => Promise<void>;
}

const COLLECTIONS: CollectionSpec[] = [
  {
    key: "vehicles",
    mongoName: "normalized_vehicles",
    pgTable: normalizedVehicles,
    upsert: (w, d) => w.upsertVehicle(d),
  },
  {
    key: "customers",
    mongoName: "normalized_customers",
    pgTable: normalizedCustomers,
    upsert: (w, d) => w.upsertCustomer(d),
  },
  {
    key: "work_orders",
    mongoName: "normalized_work_orders",
    pgTable: normalizedWorkOrders,
    upsert: (w, d) => w.upsertWorkOrder(d),
  },
  {
    key: "service_jobs",
    mongoName: "normalized_service_jobs",
    pgTable: normalizedServiceJobs,
    upsert: (w, d) => w.upsertServiceJob(d),
  },
  {
    key: "line_items",
    mongoName: "normalized_line_items",
    pgTable: normalizedLineItems,
    upsert: (w, d) => w.upsertLineItem(d),
  },
  {
    key: "payments",
    mongoName: "normalized_payments",
    pgTable: normalizedPayments,
    upsert: (w, d) => w.upsertPayment(d),
  },
];

interface Args {
  collection?: CollectionKey;
  shop?: number;
  batch: number;
  concurrency: number;
  reset: boolean;
  verifyOnly: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const out: Args = {
    batch: 250,
    concurrency: 4,
    reset: false,
    verifyOnly: false,
    dryRun: false,
  };
  for (const raw of process.argv.slice(2)) {
    const [k, v] = raw.replace(/^--/, "").split("=");
    switch (k) {
      case "collection":
        out.collection = v as CollectionKey;
        break;
      case "shop":
        out.shop = Number(v);
        break;
      case "batch":
        out.batch = Number(v);
        break;
      case "concurrency":
        out.concurrency = Number(v);
        break;
      case "reset":
        out.reset = true;
        break;
      case "verify-only":
        out.verifyOnly = true;
        break;
      case "dry-run":
        out.dryRun = true;
        break;
      default:
        console.warn(`Unknown arg: --${k}`);
    }
  }
  return out;
}

const CHECKPOINT_DIR = path.join(process.cwd(), ".local");
const CHECKPOINT_FILE = path.join(CHECKPOINT_DIR, "backfill-checkpoint.json");

interface Checkpoint {
  [key: string]: {
    lastId: string | null;
    processed: number;
    upserted: number;
    failed: number;
    failedIds: string[]; // doc _ids that errored; retried on subsequent runs before advancing past them
    finishedAt?: string;
  };
}

function checkpointKey(spec: CollectionSpec, shopFilter?: number): string {
  return shopFilter != null ? `${spec.key}:shop=${shopFilter}` : `${spec.key}:all`;
}

function loadCheckpoint(): Checkpoint {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  if (!fs.existsSync(CHECKPOINT_DIR)) fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

async function processInBatches<T extends { _id: any }>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<{ ok: number; failed: number; failedIds: string[]; errors: string[] }> {
  let ok = 0;
  let failed = 0;
  const failedIds: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const results = await Promise.allSettled(slice.map(worker));
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") ok++;
      else {
        failed++;
        failedIds.push(String(slice[idx]._id));
        if (errors.length < 5) errors.push(String(r.reason?.message || r.reason));
      }
    });
  }
  return { ok, failed, failedIds, errors };
}

async function backfillOne(spec: CollectionSpec, args: Args): Promise<void> {
  const mongo = await getMongoDb();
  const pg = getPgDb();
  const writer = new SupabaseDualWriter(pg);

  const cpAll = loadCheckpoint();
  const key = checkpointKey(spec, args.shop);
  if (args.reset) delete cpAll[key];
  const cp = cpAll[key] ?? {
    lastId: null,
    processed: 0,
    upserted: 0,
    failed: 0,
    failedIds: [],
  };
  if (!Array.isArray(cp.failedIds)) cp.failedIds = [];

  // Retry previously-failed docs first so checkpoint advancement stays safe.
  if (cp.failedIds.length > 0 && !args.dryRun) {
    console.log(`  [${spec.key}] retrying ${cp.failedIds.length} previously-failed doc(s)...`);
    const retryDocs = await mongo
      .collection(spec.mongoName)
      .find({ _id: { $in: cp.failedIds } })
      .toArray();
    const writerRetry = new SupabaseDualWriter(pg);
    const r = await processInBatches(retryDocs, args.concurrency, (d) =>
      spec.upsert(writerRetry, d),
    );
    const stillFailed = new Set(r.failedIds);
    cp.upserted += r.ok;
    cp.failed = stillFailed.size; // counter reflects current outstanding
    cp.failedIds = Array.from(stillFailed);
    cpAll[key] = cp;
    saveCheckpoint(cpAll);
    if (r.errors.length) console.error(`  [${spec.key}] retry errors:`, r.errors);
    console.log(`  [${spec.key}] retry result: ok=${r.ok} stillFailed=${stillFailed.size}`);
  }

  const filter: Record<string, any> = {};
  if (args.shop != null) filter.shopId = args.shop;
  if (cp.lastId) filter._id = { $gt: cp.lastId };

  const total = await mongo.collection(spec.mongoName).countDocuments(filter);
  console.log(
    `\n[${spec.key}] starting backfill — ${total.toLocaleString()} docs to process` +
      (cp.lastId ? ` (resuming from _id > ${cp.lastId})` : "") +
      (args.shop != null ? ` (shop=${args.shop})` : ""),
  );
  if (total === 0) {
    cp.finishedAt = new Date().toISOString();
    cpAll[key] = cp;
    saveCheckpoint(cpAll);
    return;
  }

  const cursor = mongo
    .collection(spec.mongoName)
    .find(filter)
    .sort({ _id: 1 })
    .batchSize(args.batch);

  let buffer: any[] = [];
  const startedAt = Date.now();

  const flush = async () => {
    if (!buffer.length) return;
    if (args.dryRun) {
      // Dry run: count only, never mutate or persist the checkpoint.
      console.log(`  [${spec.key}] [dry-run] would process ${buffer.length} docs`);
      buffer = [];
      return;
    }
    const { ok, failed, failedIds, errors } = await processInBatches(
      buffer,
      args.concurrency,
      (doc) => spec.upsert(writer, doc),
    );
    cp.upserted += ok;
    cp.failed += failed;
    cp.failedIds.push(...failedIds);
    cp.processed += buffer.length;
    // Safe to advance lastId past this batch because failedIds are persisted
    // in the checkpoint and will be retried on the next run before any new
    // forward progress is allowed.
    cp.lastId = String(buffer[buffer.length - 1]._id);
    cpAll[key] = cp;
    saveCheckpoint(cpAll);
    if (errors.length) {
      console.error(`  [${spec.key}] sample errors in batch:`, errors);
    }
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = cp.processed / Math.max(elapsed, 1);
    const eta = (total - cp.processed) / Math.max(rate, 1);
    console.log(
      `  [${spec.key}] processed=${cp.processed.toLocaleString()}/${total.toLocaleString()} ok=${cp.upserted} failed=${cp.failed} rate=${rate.toFixed(0)}/s eta=${Math.round(eta)}s`,
    );
    buffer = [];
  };

  for await (const doc of cursor) {
    buffer.push(doc);
    if (buffer.length >= args.batch) await flush();
  }
  await flush();

  cp.finishedAt = new Date().toISOString();
  cpAll[key] = cp;
  saveCheckpoint(cpAll);
  console.log(
    `[${spec.key}] DONE — processed=${cp.processed.toLocaleString()} upserted=${cp.upserted.toLocaleString()} failedOutstanding=${cp.failedIds.length}`,
  );
}

async function verify(spec: CollectionSpec, args: Args): Promise<void> {
  const mongo = await getMongoDb();
  const pg = getPgDb();
  const filter: Record<string, any> = {};
  if (args.shop != null) filter.shopId = args.shop;
  const mongoCount = await mongo.collection(spec.mongoName).countDocuments(filter);

  const pgRows = args.shop != null
    ? await (pg as any).execute(
        sql`select count(*)::bigint as c from ${spec.pgTable} where shop_id = ${args.shop}`,
      )
    : await (pg as any).execute(sql`select count(*)::bigint as c from ${spec.pgTable}`);
  const pgCount = Number(pgRows.rows?.[0]?.c ?? pgRows[0]?.c ?? 0);

  const diff = mongoCount - pgCount; // positive => PG missing rows; negative => PG has extras
  const pct = mongoCount === 0 ? 100 : ((pgCount / mongoCount) * 100).toFixed(2);
  const tolerance = Math.max(5, mongoCount * 0.01);
  const status = Math.abs(diff) <= tolerance ? "OK" : diff > 0 ? "DRIFT(under)" : "DRIFT(over)";
  console.log(
    `[verify ${spec.key}] mongo=${mongoCount.toLocaleString()} pg=${pgCount.toLocaleString()} diff=${diff.toLocaleString()} coverage=${pct}% ${status}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const targets = args.collection
    ? COLLECTIONS.filter((c) => c.key === args.collection)
    : COLLECTIONS;

  if (targets.length === 0) {
    console.error(`Unknown --collection. Valid: ${COLLECTIONS.map((c) => c.key).join(", ")}`);
    process.exit(1);
  }

  console.log(
    `Backfill plan: ${targets.map((t) => t.key).join(" → ")}` +
      (args.shop != null ? ` (shop=${args.shop})` : "") +
      (args.dryRun ? " [DRY RUN]" : "") +
      (args.verifyOnly ? " [VERIFY ONLY]" : ""),
  );

  if (!args.verifyOnly) {
    for (const spec of targets) {
      try {
        await backfillOne(spec, args);
      } catch (e: any) {
        console.error(`[${spec.key}] FATAL:`, e?.stack || e?.message || e);
      }
    }
  }

  console.log("\n=== Verification ===");
  for (const spec of targets) {
    try {
      await verify(spec, args);
    } catch (e: any) {
      console.error(`[verify ${spec.key}] failed:`, e?.message || e);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
