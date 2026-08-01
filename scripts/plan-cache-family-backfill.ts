/**
 * Task #998 — durable-store backfill for the plan & analysis cache family.
 *
 * Copies the NON-TTL Mongo stores in the family into their PG mirror
 * tables (the TTL caches — cached_plans, maintenance_analysis_cache,
 * ai_analysis_cache, plan_prefetch_cache, recommendations_cache — need
 * no backfill: they cut over by writing PG-first and letting Mongo
 * entries age out):
 *
 *   - recommendation_events  → recommendation_events   (append-only; idempotent on backfill_mongo_id)
 *   - recommendations        → recommendations          (idempotent on backfill_mongo_id)
 *   - cached_work_orders     → cached_work_orders       (idempotent on (shop_id, cache_key = mongo _id))
 *
 * `report_approved_items` and `remedied_deferred_work` are already
 * covered by scripts/wave2-mongo-to-pg-backfill.ts — run that too.
 *
 * OPERATOR-ONLY: run off-peak against production (dev Mongo IS prod).
 *
 * Usage:
 *   npx tsx scripts/plan-cache-family-backfill.ts [--store <name>] [--shop <shopId>] [--dry-run]
 *
 * Resumable: progress is checkpointed per store to
 * .plan-cache-family-backfill-resume.json (last processed Mongo _id);
 * re-running continues from the checkpoint. Delete the file to restart.
 * Chunked: documents stream in _id order in batches of 500 with a small
 * inter-batch delay so shared Mongo is never saturated.
 */
import fs from "fs";
import path from "path";
import { ObjectId } from "mongodb";
import { getDb as getMongo } from "../lib/mongo";
import {
  pgInsertRecommendationEvent,
  pgInsertRecommendation,
  pgUpsertCachedWorkOrder,
} from "../lib/data/repositories/pg/plan-cache";

const RESUME_FILE = path.join(process.cwd(), ".plan-cache-family-backfill-resume.json");
const BATCH_SIZE = 500;
const BATCH_DELAY_MS = 250;

type ResumeState = Record<string, string>; // store -> last processed _id hex

function loadResume(): ResumeState {
  try {
    return JSON.parse(fs.readFileSync(RESUME_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveResume(state: ResumeState) {
  fs.writeFileSync(RESUME_FILE, JSON.stringify(state, null, 2));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface StoreSpec {
  name: string;
  /** Copies one Mongo doc into PG. Must be idempotent. */
  copy: (doc: Record<string, unknown>) => Promise<void>;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const STORES: StoreSpec[] = [
  {
    name: "recommendation_events",
    copy: async (doc) => {
      try {
        await pgInsertRecommendationEvent(doc);
      } catch (err) {
        // Unique violation on backfill_mongo_id = already copied — skip.
        if ((err as { code?: string })?.code !== "23505") throw err;
      }
    },
  },
  {
    name: "recommendations",
    copy: async (doc) => {
      const id = (doc._id as ObjectId).toHexString();
      const createdAt =
        doc.createdAt instanceof Date
          ? doc.createdAt
          : (doc._id as ObjectId).getTimestamp();
      const { _id, ...payload } = doc;
      await pgInsertRecommendation(
        num(doc.shopId),
        typeof doc.vin === "string" ? doc.vin : null,
        id,
        payload,
        createdAt,
      );
    },
  },
  {
    name: "cached_work_orders",
    copy: async (doc) => {
      const shopId = num(doc.shopId);
      if (shopId == null) return; // unkeyable legacy row — skip
      const id = (doc._id as ObjectId).toHexString();
      const cachedAt =
        doc.createdAt instanceof Date
          ? doc.createdAt
          : (doc._id as ObjectId).getTimestamp();
      const { _id, ...payload } = doc;
      await pgUpsertCachedWorkOrder(shopId, id, payload, cachedAt);
    },
  },
];

async function backfillStore(
  spec: StoreSpec,
  resume: ResumeState,
  shopFilter: number | null,
  dryRun: boolean,
): Promise<void> {
  const mongo = await getMongo();
  const col = mongo.collection(spec.name);
  const baseFilter: Record<string, unknown> = shopFilter
    ? { shopId: { $in: [shopFilter, String(shopFilter)] } }
    : {};

  let lastId = resume[spec.name] ? new ObjectId(resume[spec.name]) : null;
  let copied = 0;
  const total = await col.countDocuments(baseFilter);
  console.log(`[${spec.name}] total=${total} resumeFrom=${lastId ?? "(start)"}${dryRun ? " DRY-RUN" : ""}`);

  for (;;) {
    const filter = lastId ? { ...baseFilter, _id: { $gt: lastId } } : baseFilter;
    const batch = await col.find(filter).sort({ _id: 1 }).limit(BATCH_SIZE).toArray();
    if (batch.length === 0) break;

    if (!dryRun) {
      for (const doc of batch) {
        await spec.copy(doc as Record<string, unknown>);
      }
    }
    copied += batch.length;
    lastId = batch[batch.length - 1]._id as ObjectId;
    if (!dryRun && !shopFilter) {
      resume[spec.name] = lastId.toHexString();
      saveResume(resume);
    }
    console.log(`[${spec.name}] processed=${copied}/${total} lastId=${lastId}`);
    await sleep(BATCH_DELAY_MS);
  }
  console.log(`[${spec.name}] DONE (${copied} docs${dryRun ? ", dry-run — nothing written" : ""})`);
}

async function main() {
  const args = process.argv.slice(2);
  const storeArg = args.includes("--store") ? args[args.indexOf("--store") + 1] : null;
  const shopArg = args.includes("--shop") ? Number(args[args.indexOf("--shop") + 1]) : null;
  const dryRun = args.includes("--dry-run");

  const stores = storeArg ? STORES.filter((s) => s.name === storeArg) : STORES;
  if (stores.length === 0) {
    console.error(`Unknown --store "${storeArg}". Valid: ${STORES.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  const resume = loadResume();
  for (const spec of stores) {
    await backfillStore(spec, resume, shopArg, dryRun);
  }
  console.log("All requested stores backfilled.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Backfill failed (resume file preserved — rerun to continue):", err);
  process.exit(1);
});
