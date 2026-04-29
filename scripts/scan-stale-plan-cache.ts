/**
 * Task #197: Scan `cached_plans` for entries below the current
 * PLAN_CACHE_SCHEMA_VERSION and optionally clear them.
 *
 * Functionally, the read path in `lib/plan-cache.ts#getCachedPlan` already
 * skips any document whose `schemaVersion` is below the current version
 * (treating a missing field as v1), so flagged-engine vehicles will refresh
 * on the next dashboard / extension read without this script being run.
 *
 * This script is a safety net for ops: it surfaces how many stale entries
 * still exist (per shop, per schema version) and can physically delete them
 * so MongoDB doesn't carry unreachable cache rows around forever.
 *
 * Usage:
 *   # Report only (dry-run, default):
 *   npx tsx scripts/scan-stale-plan-cache.ts
 *
 *   # Actually delete stale entries:
 *   npx tsx scripts/scan-stale-plan-cache.ts --clear
 *
 *   # Use a custom lower bound (default = PLAN_CACHE_SCHEMA_VERSION):
 *   npx tsx scripts/scan-stale-plan-cache.ts --min=4
 *   npx tsx scripts/scan-stale-plan-cache.ts --min=4 --clear
 */

import { getDb } from "../lib/mongo";
import { PLAN_CACHE_SCHEMA_VERSION } from "../lib/plan-cache";

interface Args {
  clear: boolean;
  minVersion: number;
}

function parseArgs(argv: string[]): Args {
  let clear = false;
  let minVersion = PLAN_CACHE_SCHEMA_VERSION;

  for (const arg of argv) {
    if (arg === "--clear" || arg === "-c") {
      clear = true;
    } else if (arg.startsWith("--min=")) {
      const parsed = Number(arg.slice("--min=".length));
      if (!Number.isFinite(parsed) || parsed < 1) {
        console.error(`Invalid --min value: ${arg}`);
        process.exit(1);
      }
      minVersion = parsed;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: tsx scripts/scan-stale-plan-cache.ts [--clear] [--min=N]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  return { clear, minVersion };
}

async function main() {
  const { clear, minVersion } = parseArgs(process.argv.slice(2));

  console.log(
    `[scan-stale-plan-cache] current PLAN_CACHE_SCHEMA_VERSION=${PLAN_CACHE_SCHEMA_VERSION}, scanning for entries with schemaVersion < ${minVersion} (${clear ? "CLEAR" : "REPORT-ONLY"})`,
  );

  const db = await getDb();
  const coll = db.collection("cached_plans");

  // Treat a missing schemaVersion as v1 (matches getCachedPlan's read-path
  // fallback). We use $expr + $ifNull so the version comparison includes
  // legacy documents that were written before the field existed.
  const staleFilter = {
    $expr: {
      $lt: [{ $ifNull: ["$schemaVersion", 1] }, minVersion],
    },
  };

  const total = await coll.countDocuments({});
  const staleCount = await coll.countDocuments(staleFilter);

  console.log(
    `[scan-stale-plan-cache] cached_plans total=${total}, stale=${staleCount}`,
  );

  if (staleCount > 0) {
    const breakdown = await coll
      .aggregate([
        { $match: staleFilter },
        {
          $group: {
            _id: {
              schemaVersion: { $ifNull: ["$schemaVersion", 1] },
              shopId: "$shopId",
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.schemaVersion": 1, "_id.shopId": 1 } },
      ])
      .toArray();

    console.log("[scan-stale-plan-cache] breakdown (schemaVersion, shopId, count):");
    for (const row of breakdown) {
      const sv = row._id?.schemaVersion ?? "?";
      const shop = row._id?.shopId ?? "?";
      console.log(`  v${sv}  shopId=${shop}  count=${row.count}`);
    }
  }

  if (clear && staleCount > 0) {
    const result = await coll.deleteMany(staleFilter);
    console.log(
      `[scan-stale-plan-cache] DELETED ${result.deletedCount} stale entr${result.deletedCount === 1 ? "y" : "ies"}`,
    );
  } else if (!clear && staleCount > 0) {
    console.log(
      "[scan-stale-plan-cache] dry-run: pass --clear to delete the stale entries",
    );
  } else {
    console.log("[scan-stale-plan-cache] nothing to clear");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[scan-stale-plan-cache] failed:", err);
  process.exit(1);
});
