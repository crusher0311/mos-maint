/**
 * One-shot: flip every Precision Auto Service enterprise shop to kilometers.
 *
 * The whole enterprise is in Canada, so `shop.preferences.distanceUnit` should
 * be "kilometers". Once flipped, lib/plan-cache.ts auto-invalidates any cached
 * plan whose stored distanceUnit no longer matches the shop preference, so the
 * next VHI page view rebuilds the buckets in km (triage.ts converts OEM mile
 * intervals at intake) and the dashboard labels render "km" instead of "mi".
 *
 * Usage:
 *   npx tsx scripts/set-precision-auto-distance-unit-km.ts            # dry run
 *   npx tsx scripts/set-precision-auto-distance-unit-km.ts --apply    # writes
 */

import { getDb } from "../lib/mongo";

async function main() {
  const apply = process.argv.includes("--apply");
  const db = await getDb();

  const matchedShops = await db
    .collection("shops")
    .find({ name: { $regex: /precision auto service/i } })
    .project({ _id: 1, shopId: 1, name: 1, enterpriseId: 1, "preferences.distanceUnit": 1 })
    .toArray();

  if (matchedShops.length === 0) {
    console.log("No shops matched /precision auto service/i. Aborting.");
    return;
  }

  const enterpriseIds = Array.from(
    new Set(
      matchedShops
        .map((s) => s.enterpriseId)
        .filter((id) => id != null)
        .map((id) => String(id))
    )
  );

  let allShops = matchedShops;
  if (enterpriseIds.length > 0) {
    const siblings = await db
      .collection("shops")
      .find({ enterpriseId: { $in: matchedShops.map((s) => s.enterpriseId).filter(Boolean) } })
      .project({ _id: 1, shopId: 1, name: 1, enterpriseId: 1, "preferences.distanceUnit": 1 })
      .toArray();
    const byKey = new Map<string, any>();
    for (const s of [...matchedShops, ...siblings]) byKey.set(String(s._id), s);
    allShops = Array.from(byKey.values());
  }

  console.log(`Found ${allShops.length} shop(s) to update:`);
  console.log(
    allShops
      .map(
        (s) =>
          `  - shopId=${s.shopId} name="${s.name}" enterpriseId=${s.enterpriseId ?? "(none)"} currentDistanceUnit=${s.preferences?.distanceUnit ?? "(unset)"}`
      )
      .join("\n")
  );

  const targets = allShops.filter((s) => s.preferences?.distanceUnit !== "kilometers");
  if (targets.length === 0) {
    console.log("\nAll matched shops already have distanceUnit=kilometers. Nothing to do.");
    return;
  }

  console.log(`\n${targets.length} shop(s) need flipping to "kilometers".`);

  if (!apply) {
    console.log("\nDRY RUN — pass --apply to write the change.");
    return;
  }

  const result = await db.collection("shops").updateMany(
    { _id: { $in: targets.map((s) => s._id) } },
    { $set: { "preferences.distanceUnit": "kilometers" } }
  );

  console.log(
    `\nUpdated. matchedCount=${result.matchedCount} modifiedCount=${result.modifiedCount}`
  );
  console.log(
    "Cached plans will rebuild automatically on next VHI page view (lib/plan-cache.ts skips on unit mismatch)."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
