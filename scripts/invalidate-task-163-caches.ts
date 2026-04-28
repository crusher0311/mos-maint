/**
 * Task #163: Invalidate cached plans and analysis cache for the demo VIN
 * (and optionally any VIN passed on the command line) so the bumped plan
 * shape (notes, action, recommendedDefault, ...) is regenerated on the
 * next request.
 *
 * Run:
 *   npx tsx scripts/invalidate-task-163-caches.ts
 *   npx tsx scripts/invalidate-task-163-caches.ts <VIN1> <VIN2> ...
 *
 * Note: bumping `PLAN_CACHE_SCHEMA_VERSION` already causes
 * `getCachedPlan` to skip stale entries on read, so this script only
 * guarantees that the entries are physically removed (also clears the
 * `maintenance_analysis_cache` collection which has its own shape).
 */

import { getDb } from "../lib/mongo";

const DEMO_VIN = "1C6RR6FG7KS516181";

async function main() {
  const vins = Array.from(
    new Set(
      [DEMO_VIN, ...process.argv.slice(2)]
        .map((v) => v.trim().toUpperCase())
        .filter((v) => v.length === 17),
    ),
  );

  if (vins.length === 0) {
    console.error("No VINs to invalidate.");
    process.exit(1);
  }

  const db = await getDb();

  for (const vin of vins) {
    const planResult = await db
      .collection("cached_plans")
      .deleteMany({ vin });
    console.log(
      `[invalidate] cached_plans   ${vin} -> deleted ${planResult.deletedCount}`,
    );

    const analysisResult = await db
      .collection("maintenance_analysis_cache")
      .deleteMany({ vin });
    console.log(
      `[invalidate] analysis_cache ${vin} -> deleted ${analysisResult.deletedCount}`,
    );
  }

  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[invalidate] failed:", err);
  process.exit(1);
});
