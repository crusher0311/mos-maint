/**
 * Task #479 one-shot cleanup: null out fake `0` mileage anchors in cached
 * plan payloads.
 *
 * Background
 * ----------
 * The extension plan route used to serialize `dueMileage: 0` (and
 * `milesToGo: 0`) for month-only OEM rules (e.g. brake fluid: 36 months, no
 * mileage interval) and for DVI-finding rows. Those recommendations are
 * persisted into `maintenance_analysis_cache`, and partner readers convert
 * `dueMileage` → `dueAtMiles`, where a literal 0 anchor made legacy
 * mileage math report "remaining = 0 - currentMiles" — i.e. the vehicle's
 * ENTIRE odometer as overdue miles ("111,961 mi over" on brake fluid).
 *
 * The live writers now persist null (app/api/extension/plan/route.ts) and
 * the readers normalize/guard (lib/vhi-score.ts convertRecToTriaged,
 * lib/vhi-progress.ts dueAtMiles > 0 guard). This script cleans the
 * ALREADY-CACHED documents so stale rows can't resurface the bug through
 * any other reader:
 *   - maintenance_analysis_cache: recommendations[] with dueMileage === 0
 *     → dueMileage: null (+ milesToGo: null on those same rows — it carried
 *     the same 0 sentinel).
 *   - cached_plans: plan.buckets.{overdue,dueSoon,upcoming,complimentary}[]
 *     items with dueAtMiles === 0 → dueAtMiles: null (+ milesToGo: null).
 *
 * A dueAt odometer of 0 is never a real reading, so ALL zeros are nulled
 * (counts are reported split by whether the row had a mileage interval).
 *
 * SAFETY — this touches the PRODUCTION Mongo cluster
 * --------------------------------------------------
 * The dev Mongo for this repl IS the production cluster. Therefore:
 *   - DEFAULTS TO DRY RUN. Writes only happen with `--confirm`.
 *   - PACED: sleeps between batches (default 250ms) so it never hammers
 *     shared Mongo. Run off-peak.
 *
 * Run:
 *   npx tsx scripts/fix-zero-due-at-miles.ts            # dry run (read-only)
 *   npx tsx scripts/fix-zero-due-at-miles.ts --confirm  # apply fixes
 *   npx tsx scripts/fix-zero-due-at-miles.ts --confirm --sleep 500
 */

import { getDb } from "../lib/mongo";

const CONFIRM = process.argv.includes("--confirm");
const sleepArgIdx = process.argv.indexOf("--sleep");
const SLEEP_MS =
  sleepArgIdx >= 0 && process.argv[sleepArgIdx + 1]
    ? Math.max(0, Number(process.argv[sleepArgIdx + 1]) || 250)
    : 250;
const BATCH_SIZE = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BUCKET_KEYS = ["overdue", "dueSoon", "upcoming", "complimentary"] as const;

async function fixAnalysisCache(db: any) {
  const coll = db.collection("maintenance_analysis_cache");
  const filter = { "recommendations.dueMileage": 0 };
  const total = await coll.countDocuments(filter);
  console.log(`\n[maintenance_analysis_cache] documents with a dueMileage:0 rec: ${total}`);

  let docsFixed = 0;
  let recsFixed = 0;
  let recsTimeOnly = 0;
  let recsWithInterval = 0;

  while (true) {
    const docs = await coll
      .find(filter, { projection: { _id: 1, recommendations: 1 } })
      .limit(BATCH_SIZE)
      .toArray();
    if (docs.length === 0) break;

    for (const doc of docs) {
      const recs = Array.isArray(doc.recommendations) ? doc.recommendations : [];
      let changed = false;
      for (const rec of recs) {
        if (rec && rec.dueMileage === 0) {
          const hasMilesInterval =
            (rec.intervalMiles ?? rec.interval ?? 0) > 0;
          if (hasMilesInterval) recsWithInterval++;
          else recsTimeOnly++;
          rec.dueMileage = null;
          if (rec.milesToGo === 0) rec.milesToGo = null;
          recsFixed++;
          changed = true;
        }
      }
      if (changed) {
        docsFixed++;
        if (CONFIRM) {
          await coll.updateOne({ _id: doc._id }, { $set: { recommendations: recs } });
        }
      }
    }

    if (!CONFIRM) break; // dry run: one batch is enough to sample; totals come from counts below
    await sleep(SLEEP_MS);
  }

  if (!CONFIRM) {
    console.log(
      `  DRY RUN — sampled first ${Math.min(BATCH_SIZE, total)} docs: ` +
      `${recsFixed} zero-dueMileage recs (${recsTimeOnly} time-only/DVI, ${recsWithInterval} with a mileage interval). ` +
      `${total} total docs would be rewritten.`
    );
  } else {
    console.log(
      `  FIXED ${docsFixed} docs / ${recsFixed} recs ` +
      `(${recsTimeOnly} time-only/DVI, ${recsWithInterval} with a mileage interval).`
    );
  }
}

async function fixCachedPlans(db: any) {
  const coll = db.collection("cached_plans");
  const filter = {
    $or: BUCKET_KEYS.map((k) => ({ [`plan.buckets.${k}.dueAtMiles`]: 0 })),
  };
  const total = await coll.countDocuments(filter);
  console.log(`\n[cached_plans] documents with a dueAtMiles:0 item: ${total}`);

  let docsFixed = 0;
  let itemsFixed = 0;
  let itemsTimeOnly = 0;
  let itemsWithInterval = 0;

  while (true) {
    const docs = await coll
      .find(filter, { projection: { _id: 1, "plan.buckets": 1 } })
      .limit(BATCH_SIZE)
      .toArray();
    if (docs.length === 0) break;

    for (const doc of docs) {
      const buckets = doc.plan?.buckets ?? {};
      let changed = false;
      for (const key of BUCKET_KEYS) {
        const items = Array.isArray(buckets[key]) ? buckets[key] : [];
        for (const item of items) {
          if (item && item.dueAtMiles === 0) {
            if ((item.intervalMiles ?? 0) > 0) itemsWithInterval++;
            else itemsTimeOnly++;
            item.dueAtMiles = null;
            if (item.milesToGo === 0) item.milesToGo = null;
            itemsFixed++;
            changed = true;
          }
        }
      }
      if (changed) {
        docsFixed++;
        if (CONFIRM) {
          await coll.updateOne({ _id: doc._id }, { $set: { "plan.buckets": buckets } });
        }
      }
    }

    if (!CONFIRM) break;
    await sleep(SLEEP_MS);
  }

  if (!CONFIRM) {
    console.log(
      `  DRY RUN — sampled first ${Math.min(BATCH_SIZE, total)} docs: ` +
      `${itemsFixed} zero-dueAtMiles items (${itemsTimeOnly} time-only/DVI, ${itemsWithInterval} with a mileage interval). ` +
      `${total} total docs would be rewritten.`
    );
  } else {
    console.log(
      `  FIXED ${docsFixed} docs / ${itemsFixed} items ` +
      `(${itemsTimeOnly} time-only/DVI, ${itemsWithInterval} with a mileage interval).`
    );
  }
}

async function main() {
  console.log(
    `fix-zero-due-at-miles (Task #479) — mode: ${CONFIRM ? "APPLY (--confirm)" : "DRY RUN"}, ` +
    `batch=${BATCH_SIZE}, sleep=${SLEEP_MS}ms`
  );
  const db = await getDb();
  await fixAnalysisCache(db);
  await fixCachedPlans(db);
  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("fix-zero-due-at-miles failed:", err);
  process.exit(1);
});
