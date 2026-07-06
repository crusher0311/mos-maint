/**
 * Recovery for the "webhook received but jobs never indexed" gap.
 *
 * Root cause (see .agents/memory/webhook-indexed-jobs-gap.md): the terminal
 * Tekmetric webhook only filed jobs into `job_index` when the cache row already
 * had a `vin`. The webhook payload carries `vehicleId`, not `vin`, and the
 * separate vehicle enrichment often lags or misses — so posted ROs were silently
 * skipped and their work never became searchable history. The plan/last-performed
 * layer then falls back to CARFAX, showing "last done via CARFAX" for work the
 * shop actually performed. Measured ~9% of posted ROs fleet-wide (up to ~26% at
 * some shops).
 *
 * This script re-files the already-missed ROs. For each posted RO that has
 * `data.jobs` but no `job_index` entry, it resolves the VIN (from the cache row
 * or, if missing, via Tekmetric `getVehicle`), persists it back onto the cache
 * row, then indexes the jobs from the stored payload (no /jobs API call needed).
 *
 * Detection is driven off `tekmetric_webhook_logs` (indexed on receivedAt) for a
 * recent window, then a targeted findOne per RO — this avoids full scans of
 * `tekmetric_work_orders` (each doc carries a large `data` blob and full scans
 * time out).
 *
 * NOTE: dev Mongo IS prod Mongo for this repl — --apply writes to live data.
 *
 * Usage:
 *   npx tsx scripts/reindex-missing-tekmetric-jobs.ts --shop=32 --days=14           # dry run
 *   npx tsx scripts/reindex-missing-tekmetric-jobs.ts --shop=32 --days=14 --apply   # recover
 */

import { MongoClient } from "mongodb";
import { getVehicle } from "@/lib/integrations/tekmetric/client";
import { indexTekmetricWorkOrderJobs } from "@/lib/integrations/tekmetric/job-index";

const APPLY = process.argv.includes("--apply");
const shopFlag = process.argv.find((a) => a.startsWith("--shop="));
const daysFlag = process.argv.find((a) => a.startsWith("--days="));
const SHOP_ID = shopFlag ? Number(shopFlag.split("=")[1]) : null;
const DAYS = daysFlag ? Number(daysFlag.split("=")[1]) : 14;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function main() {
  if (!SHOP_ID) {
    console.error("Missing --shop=<internalShopId>");
    process.exit(1);
  }
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

  console.log(`\n=== reindex-missing-tekmetric-jobs (${APPLY ? "APPLY" : "DRY RUN"}) ===`);
  console.log(`scope: shop ${SHOP_ID}, last ${DAYS} days of posted ROs`);

  const shop = await db.collection("shops").findOne(
    { shopId: { $in: [String(SHOP_ID), SHOP_ID] } },
    { projection: { shopId: 1, name: 1, "tekmetric.shopId": 1 } },
  );
  const tekShopId = shop?.tekmetric?.shopId;
  if (tekShopId == null) {
    console.error(`Shop ${SHOP_ID} has no tekmetric.shopId — not a Tekmetric shop?`);
    await client.close();
    process.exit(1);
  }
  console.log(`shop "${shop?.name}" -> tekmetric shop ${tekShopId}`);

  // 1) posted RO ids for this tek shop in the window (from webhook logs).
  // Server-side aggregation so we return only the distinct RO ids, not stream
  // ~10k+ log docs per day to the client (which times out).
  const from = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
  const aggRows = await db.collection("tekmetric_webhook_logs").aggregate([
    { $match: { receivedAt: { $gte: from }, "data.shopId": tekShopId, eventType: { $regex: "posted", $options: "i" } } },
    { $match: { "data.repairOrderNumber": { $ne: null }, "data.id": { $ne: null } } },
    { $group: { _id: "$data.id" } },
  ], { allowDiskUse: true }).toArray();
  const postedIds = aggRows.map((r: any) => String(r._id));
  console.log(`posted ROs in window: ${postedIds.length}`);

  // 2) which are already in job_index
  const idxRows = await db.collection("job_index")
    .find({ shopId: SHOP_ID, workOrderId: { $in: postedIds } }, { projection: { workOrderId: 1 } })
    .toArray();
  const indexed = new Set(idxRows.map((r: any) => String(r.workOrderId)));
  const missing = postedIds.filter((id) => !indexed.has(id));
  console.log(`already indexed: ${indexed.size} | MISSING: ${missing.length}`);

  if (missing.length === 0) {
    console.log("Nothing to recover.");
    await client.close();
    return;
  }

  // 3) inspect / recover each missing RO
  let recovered = 0, jobsFiled = 0, noJobs = 0, noVin = 0, vinResolved = 0, errors = 0;
  for (const roId of missing) {
    const row: any = await db.collection("tekmetric_work_orders").findOne({
      tekmetricShopId: tekShopId,
      workOrderId: String(roId),
    });
    if (!row) {
      // fall back to shopId-scoped lookup for older rows written before tekmetricShopId
      const alt: any = await db.collection("tekmetric_work_orders").findOne({
        shopId: { $in: [String(SHOP_ID), SHOP_ID] },
        workOrderId: String(roId),
      });
      if (!alt) { console.log(`  RO ${roId}: no cache row`); continue; }
    }
    const wo = row || (await db.collection("tekmetric_work_orders").findOne({
      shopId: { $in: [String(SHOP_ID), SHOP_ID] }, workOrderId: String(roId),
    }));
    const jobs = Array.isArray(wo?.data?.jobs) ? wo.data.jobs : [];
    if (jobs.length === 0) { noJobs++; continue; }

    let vin: string | undefined = wo.vin;
    let year = wo.vehicleYear, make = wo.vehicleMake, model = wo.vehicleModel, engine = wo.vehicleEngine;
    const vehicleId = wo.data?.vehicleId ?? wo.vehicleId;

    if (!vin && vehicleId) {
      try {
        const vehicle: any = await getVehicle(vehicleId, SHOP_ID);
        if (vehicle?.vin) {
          vin = String(vehicle.vin).toUpperCase();
          year = vehicle.year ?? year; make = vehicle.make ?? make;
          model = vehicle.model ?? model; engine = vehicle.engine ?? engine;
          vinResolved++;
          if (APPLY) {
            const patch: any = { vin, updatedAt: new Date() };
            if (vehicle.year != null) patch.vehicleYear = vehicle.year;
            if (vehicle.make) patch.vehicleMake = vehicle.make;
            if (vehicle.model) patch.vehicleModel = vehicle.model;
            if (vehicle.engine) patch.vehicleEngine = vehicle.engine;
            await db.collection("tekmetric_work_orders").updateOne({ _id: wo._id }, { $set: patch });
          }
        }
        await sleep(120);
      } catch (err: any) {
        errors++;
        console.error(`  RO ${roId}: getVehicle(${vehicleId}) failed: ${err?.message || err}`);
      }
    }

    if (!vin) { noVin++; console.log(`  RO ${roId}: ${jobs.length} jobs but no resolvable VIN`); continue; }

    const completedDate = wo.completedDate || wo.data?.completedDate || wo.data?.postedDate || wo.updatedDate || new Date().toISOString();
    const mileage = wo.odometer ?? wo.data?.milesOut ?? wo.data?.milesIn ?? null;

    if (!APPLY) {
      console.log(`  [dry] would file RO ${roId} (#${wo.workOrderNumber}) vin=${vin} jobs=${jobs.length}`);
      recovered++;
      continue;
    }

    try {
      const n = await indexTekmetricWorkOrderJobs(
        SHOP_ID, tekShopId, Number(roId), wo.workOrderNumber,
        { vin, year, make, model, engine },
        completedDate, mileage,
        { indexedVia: "reindex", preloadedJobs: jobs },
      );
      await db.collection("tekmetric_work_orders").updateOne({ _id: wo._id }, { $set: { jobsIndexed: true } });
      recovered++; jobsFiled += n;
      console.log(`  filed RO ${roId} (#${wo.workOrderNumber}) vin=${vin}: ${n} jobs`);
    } catch (err: any) {
      errors++;
      console.error(`  RO ${roId}: index failed: ${err?.message || err}`);
    }
  }

  console.log(`\nDone. missing=${missing.length} recovered=${recovered} jobsFiled=${jobsFiled} vinResolved=${vinResolved} noJobs=${noJobs} noVin=${noVin} errors=${errors}`);
  if (!APPLY) console.log("\nDry run only. Re-run with --apply to write.");
  await client.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
