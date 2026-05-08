/**
 * One-time fix for the Tekmetric shopId type mismatch.
 *
 * Background: some `shops` records have `tekmetric.shopId` stored as a STRING
 * (e.g. "18009") while others have it as a NUMBER (e.g. 469). The webhook
 * handler used to do `findOne({ "tekmetric.shopId": <number from payload> })`
 * which silently missed the string-typed shops, leaving their cache rows in
 * `tekmetric_work_orders` without a `shopId` field. The dashboard query
 * filters by `shopId`, so those rows were invisible.
 *
 * The handler is now type-tolerant via `tekmetricShopIdFilter`. This script:
 *   1. Coerces every `shops.tekmetric.shopId` STRING to a NUMBER (canonical).
 *   2. Backfills `shopId` on `tekmetric_work_orders` rows that have a known
 *      `tekmetricShopId` but no `shopId` set.
 *
 * Usage:
 *   npx tsx scripts/fix-tekmetric-shopid-types.ts             # dry run
 *   npx tsx scripts/fix-tekmetric-shopid-types.ts --apply     # actually mutate
 */

import { MongoClient } from "mongodb";

const APPLY = process.argv.includes("--apply");

async function main() {
  const user = process.env.MONGODB_USERNAME;
  const pass = process.env.MONGODB_PASSWORD;
  if (!user || !pass) {
    console.error("Missing MONGODB_USERNAME / MONGODB_PASSWORD env vars.");
    process.exit(1);
  }
  const uri = `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(
    pass,
  )}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=true&w=majority`;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("mos-maintenance-mvp");

  console.log(`\n=== fix-tekmetric-shopid-types (${APPLY ? "APPLY" : "DRY RUN"}) ===\n`);

  // Step 1: coerce string tekmetric.shopId values to numbers in shops collection.
  const stringShops = await db
    .collection("shops")
    .find({ "tekmetric.shopId": { $type: "string" } })
    .project({ shopId: 1, name: 1, "tekmetric.shopId": 1 })
    .toArray();
  console.log(`Step 1: ${stringShops.length} shops with string tekmetric.shopId`);
  for (const s of stringShops) {
    const raw = s.tekmetric?.shopId;
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      console.log(`  SKIP shopId=${s.shopId} (${s.name}) — non-numeric value: ${JSON.stringify(raw)}`);
      continue;
    }
    console.log(`  shopId=${s.shopId} (${s.name}): "${raw}" -> ${num}`);
    if (APPLY) {
      await db.collection("shops").updateOne(
        { _id: s._id as any },
        { $set: { "tekmetric.shopId": num } },
      );
    }
  }

  // Step 2: backfill `shopId` on tekmetric_work_orders rows where it's missing.
  // Build a map of every known tekmetric shop id -> internal shop id, after
  // step 1 (or as it would be after step 1, in dry-run mode).
  const allTekShops = await db
    .collection("shops")
    .find({ "tekmetric.shopId": { $exists: true, $ne: null } })
    .project({ shopId: 1, name: 1, "tekmetric.shopId": 1 })
    .toArray();
  const tekIdToInternal: Map<string, { internalId: number; name: string }> = new Map();
  for (const s of allTekShops) {
    const raw = s.tekmetric?.shopId;
    if (raw == null) continue;
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    if (s.shopId == null) continue;
    tekIdToInternal.set(String(num), { internalId: Number(s.shopId), name: s.name });
  }
  console.log(`\nStep 2: ${tekIdToInternal.size} tekmetric shops mapped to internal shop ids`);

  let totalRowsToFix = 0;
  let totalRowsFixed = 0;
  for (const [tekIdStr, { internalId, name }] of tekIdToInternal) {
    const tekIdNum = Number(tekIdStr);
    const orFilter: any[] = [
      { tekmetricShopId: tekIdNum },
      { tekmetricShopId: tekIdStr },
    ];
    const missingShopIdQuery = {
      $or: orFilter,
      $and: [
        {
          $or: [
            { shopId: { $exists: false } },
            { shopId: null },
          ],
        },
      ],
    };
    const missingCount = await db
      .collection("tekmetric_work_orders")
      .countDocuments(missingShopIdQuery as any);
    if (missingCount === 0) continue;
    console.log(
      `  shop ${internalId} (${name}) tekId=${tekIdNum}: ${missingCount} rows missing shopId`,
    );
    totalRowsToFix += missingCount;
    if (APPLY) {
      const res = await db.collection("tekmetric_work_orders").updateMany(
        missingShopIdQuery as any,
        { $set: { shopId: String(internalId), tekmetricShopId: tekIdNum } },
      );
      totalRowsFixed += res.modifiedCount;
    }
  }

  console.log(`\nTotal rows ${APPLY ? "fixed" : "that would be fixed"}: ${totalRowsToFix}`);
  if (APPLY) console.log(`Confirmed updates: ${totalRowsFixed}`);

  // Step 3: verify by re-running the dashboard-visibility count for previously
  // empty shops (HEART 122, 123, 117).
  const ALLOWED = ["Estimate", "Estimates", "Work-In-Progress", "Complete", "Completed"];
  console.log(`\nVerification — dashboard-visible row counts (post-${APPLY ? "apply" : "dry-run baseline"}):`);
  for (const checkId of [122, 123, 117]) {
    const visible = await db.collection("tekmetric_work_orders").countDocuments({
      shopId: { $in: [String(checkId), checkId] },
      vin: { $ne: null, $type: "string" },
      status: { $in: ALLOWED },
    });
    console.log(`  shop ${checkId}: ${visible}`);
  }

  await client.close();
  console.log(
    APPLY
      ? "\nDone. Re-run without --apply to verify, or watch the dashboard for shop 122/123."
      : "\nDry run complete. Re-run with --apply to mutate.",
  );
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
