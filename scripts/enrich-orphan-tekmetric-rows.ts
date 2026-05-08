/**
 * Second-pass enrichment for `tekmetric_work_orders` rows that landed via the
 * webhook handler while the shop lookup was failing (pre-`tekmetricShopIdFilter`
 * fix). Those rows have `shopId` (set by `fix-tekmetric-shopid-types.ts`) but
 * are missing `vin`, `customerName`, vehicle year/make/model — because the
 * deferred enrichment block was gated on `shop` being non-null.
 *
 * For each affected row we call Tekmetric's `/vehicles/{id}` and
 * `/customers/{id}` endpoints to backfill the missing fields, mirroring what
 * the live webhook now does correctly.
 *
 * Usage:
 *   npx tsx scripts/enrich-orphan-tekmetric-rows.ts                 # dry run
 *   npx tsx scripts/enrich-orphan-tekmetric-rows.ts --apply         # mutate
 *   npx tsx scripts/enrich-orphan-tekmetric-rows.ts --apply --shop=122
 *   npx tsx scripts/enrich-orphan-tekmetric-rows.ts --apply --limit=500
 */

import { MongoClient } from "mongodb";
import { getVehicle, getCustomer } from "@/lib/integrations/tekmetric/client";

const APPLY = process.argv.includes("--apply");
const shopFlag = process.argv.find((a) => a.startsWith("--shop="));
const limitFlag = process.argv.find((a) => a.startsWith("--limit="));
const SHOP_ID = shopFlag ? Number(shopFlag.split("=")[1]) : null;
const LIMIT = limitFlag ? Number(limitFlag.split("=")[1]) : Infinity;

const ALLOWED_STATUS = ["Estimate", "Estimates", "Work-In-Progress", "Complete", "Completed"];

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

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

  console.log(`\n=== enrich-orphan-tekmetric-rows (${APPLY ? "APPLY" : "DRY RUN"}) ===`);
  if (SHOP_ID) console.log(`scope: shop ${SHOP_ID} only`);
  if (LIMIT !== Infinity) console.log(`limit: ${LIMIT} rows`);

  const baseFilter: any = {
    vin: { $in: [null, undefined] },
    "data.vehicleId": { $exists: true, $ne: null },
    status: { $in: ALLOWED_STATUS },
  };
  if (SHOP_ID) {
    baseFilter.shopId = { $in: [String(SHOP_ID), SHOP_ID] };
  } else {
    baseFilter.shopId = { $exists: true, $ne: null };
  }

  const cursor = db.collection("tekmetric_work_orders").find(baseFilter, {
    projection: {
      _id: 1,
      workOrderId: 1,
      workOrderNumber: 1,
      shopId: 1,
      tekmetricShopId: 1,
      "data.vehicleId": 1,
      "data.customerId": 1,
      customerName: 1,
      odometer: 1,
    },
  });

  const total = await db.collection("tekmetric_work_orders").countDocuments(baseFilter);
  console.log(`Found ${total} active rows missing vin (across active statuses)`);
  if (!APPLY) {
    const byShop = await db.collection("tekmetric_work_orders").aggregate([
      { $match: baseFilter },
      { $group: { _id: "$shopId", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]).toArray();
    console.log("by shop:", byShop);
    console.log("\nDry run only. Re-run with --apply.");
    await client.close();
    return;
  }

  let processed = 0;
  let enriched = 0;
  let vehicleErrors = 0;
  let customerErrors = 0;
  for await (const row of cursor) {
    if (processed >= LIMIT) break;
    processed++;
    const internalShopId = Number(row.shopId);
    const vehicleId = row.data?.vehicleId;
    const customerId = row.data?.customerId;
    const enrichFields: any = {};

    try {
      const vehicle: any = await getVehicle(vehicleId, internalShopId);
      if (vehicle?.vin) enrichFields.vin = String(vehicle.vin).toUpperCase();
      if (vehicle?.year != null) enrichFields.vehicleYear = vehicle.year;
      if (vehicle?.make) enrichFields.vehicleMake = vehicle.make;
      if (vehicle?.model) enrichFields.vehicleModel = vehicle.model;
      if (vehicle?.engine) enrichFields.vehicleEngine = vehicle.engine;
      const vehicleMileage = (vehicle?.mileageIn || vehicle?.mileageOut || 0) as number;
      if (!row.odometer && vehicleMileage > 0) enrichFields.odometer = vehicleMileage;
    } catch (err: any) {
      vehicleErrors++;
      console.error(
        `  vehicle ${vehicleId} (shop ${internalShopId}, RO #${row.workOrderNumber}): ${err?.message || err}`,
      );
    }

    if (customerId && (!row.customerName || row.customerName === "Unknown Customer")) {
      try {
        const customer: any = await getCustomer(customerId, internalShopId);
        const fullName = `${customer?.firstName || ""} ${customer?.lastName || ""}`.trim();
        if (fullName) enrichFields.customerName = fullName;
      } catch (err: any) {
        customerErrors++;
        console.error(
          `  customer ${customerId} (shop ${internalShopId}, RO #${row.workOrderNumber}): ${err?.message || err}`,
        );
      }
    }

    if (Object.keys(enrichFields).length > 0) {
      enrichFields.updatedAt = new Date();
      await db.collection("tekmetric_work_orders").updateOne(
        { _id: row._id },
        { $set: enrichFields },
      );
      enriched++;
      if (enriched % 25 === 0) {
        console.log(
          `  progress: ${processed}/${total} processed, ${enriched} enriched, vehicleErrs=${vehicleErrors}, customerErrs=${customerErrors}`,
        );
      }
    }

    // Throttle: ~5 req/sec total (vehicle + customer per row) keeps us well
    // under Tekmetric's 600/min budget across however many shops we hit.
    await sleep(120);
  }

  console.log(
    `\nDone. processed=${processed}, enriched=${enriched}, vehicleErrors=${vehicleErrors}, customerErrors=${customerErrors}`,
  );

  // Verification: dashboard-visible counts for the shops we likely touched.
  const verifyShops = SHOP_ID ? [SHOP_ID] : [122, 123, 117, 82, 112, 36, 37];
  console.log(`\nDashboard-visible row counts:`);
  for (const sid of verifyShops) {
    const visible = await db.collection("tekmetric_work_orders").countDocuments({
      shopId: { $in: [String(sid), sid] },
      vin: { $ne: null, $type: "string" },
      status: { $in: ALLOWED_STATUS },
    });
    console.log(`  shop ${sid}: ${visible}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
