/**
 * One-off: fill in vin / year / make / model / customerName on incomplete
 * `tekmetric_work_orders` cache rows so the keytag + oil sticker (ro-context)
 * serve them instantly instead of falling back to the live Tekmetric API.
 *
 * Background: ro-context treats a row as "incomplete" (→ slow live API) unless
 * vin + customerName + vehicleYear + vehicleMake + vehicleModel are all present.
 * Webhooks keep the cache fresh but historically skipped vehicle enrichment when
 * a row already had a vin, leaving make/model permanently missing. The handler
 * fix only helps rows touched by a FUTURE webhook; this backfills existing rows.
 * See .agents/memory/tekmetric-ro-context-cache.md.
 *
 * Usage:
 *   TEK_SHOP_ID=15807 npx tsx scripts/one-off/enrich-incomplete-tekmetric-rows.ts
 *   DRY_RUN=1 TEK_SHOP_ID=15807 npx tsx scripts/one-off/enrich-incomplete-tekmetric-rows.ts
 */
import { MongoClient } from "mongodb";
import {
  getVehicle,
  getCustomer,
  getRepairOrder,
} from "@/lib/integrations/tekmetric/client";

const TEK_SHOP_ID = Number(process.env.TEK_SHOP_ID || "15807");
const DRY_RUN = process.env.DRY_RUN === "1";
const DB_NAME = "mos-maintenance-mvp";
const THROTTLE_MS = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const blank = (v: any) => v === null || v === undefined || v === "";

async function main() {
  const user = encodeURIComponent(process.env.MONGODB_USERNAME || "");
  const pass = encodeURIComponent(process.env.MONGODB_PASSWORD || "");
  const uri = `mongodb+srv://${user}:${pass}@mos-maintenance-mvp.tiixipi.mongodb.net/?retryWrites=true&w=majority`;
  const client = new MongoClient(uri);
  await client.connect();
  const col = client.db(DB_NAME).collection("tekmetric_work_orders");

  const incompleteQuery = {
    tekmetricShopId: TEK_SHOP_ID,
    $or: [
      { vin: { $in: [null, ""] } },
      { vin: { $exists: false } },
      { vehicleYear: { $in: [null, ""] } },
      { vehicleYear: { $exists: false } },
      { vehicleMake: { $in: [null, ""] } },
      { vehicleMake: { $exists: false } },
      { vehicleModel: { $in: [null, ""] } },
      { vehicleModel: { $exists: false } },
    ],
  };

  const rows = await col
    .find(incompleteQuery)
    .project({
      workOrderId: 1,
      workOrderNumber: 1,
      status: 1,
      vin: 1,
      vehicleYear: 1,
      vehicleMake: 1,
      vehicleModel: 1,
      vehicleEngine: 1,
      customerName: 1,
      odometer: 1,
      vehicleId: 1,
      customerId: 1,
      "data.vehicleId": 1,
      "data.customerId": 1,
    })
    .toArray();

  console.log(
    `[enrich] shop ${TEK_SHOP_ID}: ${rows.length} incomplete rows${DRY_RUN ? " (DRY RUN — no writes)" : ""}`,
  );

  let updated = 0,
    skipped = 0,
    failed = 0;

  for (const row of rows) {
    const roId = Number(row.workOrderId);
    let vehicleId = row.vehicleId ?? row.data?.vehicleId;
    let customerId = row.customerId ?? row.data?.customerId;

    try {
      // If we don't have the vehicle/customer ids, recover them from the RO.
      if (!vehicleId || !customerId) {
        const ro: any = await getRepairOrder(roId, TEK_SHOP_ID).catch(() => null);
        if (ro) {
          vehicleId = vehicleId ?? ro.vehicleId;
          customerId = customerId ?? ro.customerId;
        }
      }

      const [veh, cust] = await Promise.all([
        vehicleId
          ? getVehicle(Number(vehicleId), TEK_SHOP_ID).catch(() => null)
          : Promise.resolve(null),
        customerId && blank(row.customerName)
          ? getCustomer(Number(customerId), TEK_SHOP_ID).catch(() => null)
          : Promise.resolve(null),
      ]);

      const set: any = {};
      if (veh) {
        if (blank(row.vin) && (veh as any).vin)
          set.vin = String((veh as any).vin).toUpperCase();
        if (blank(row.vehicleYear) && (veh as any).year != null)
          set.vehicleYear = (veh as any).year;
        if (blank(row.vehicleMake) && (veh as any).make)
          set.vehicleMake = (veh as any).make;
        if (blank(row.vehicleModel) && (veh as any).model)
          set.vehicleModel = (veh as any).model;
        if (blank(row.vehicleEngine) && (veh as any).engine)
          set.vehicleEngine = (veh as any).engine;
        const miles = (veh as any).mileageIn || (veh as any).mileageOut;
        if (blank(row.odometer) && miles > 0) set.odometer = miles;
      }
      if (cust) {
        const name = `${(cust as any).firstName || ""} ${(cust as any).lastName || ""}`.trim();
        if (name) set.customerName = name;
      }

      if (Object.keys(set).length === 0) {
        skipped++;
        console.log(
          `  - RO #${row.workOrderNumber}: nothing to fill (vehId=${vehicleId || "none"})`,
        );
      } else if (DRY_RUN) {
        updated++;
        console.log(
          `  ~ RO #${row.workOrderNumber}: WOULD set ${Object.keys(set).join(", ")}`,
        );
      } else {
        set.updatedAt = new Date();
        await col.updateOne({ workOrderId: row.workOrderId }, { $set: set });
        updated++;
        console.log(
          `  ✓ RO #${row.workOrderNumber}: set ${Object.keys(set)
            .filter((k) => k !== "updatedAt")
            .join(", ")}`,
        );
      }
    } catch (err: any) {
      failed++;
      console.warn(`  ! RO #${row.workOrderNumber}: ${err?.message || err}`);
    }

    await sleep(THROTTLE_MS);
  }

  console.log(
    `[enrich] done — updated:${updated} skipped:${skipped} failed:${failed}`,
  );
  await client.close();
}

main().catch((e) => {
  console.error("[enrich] FATAL:", e?.message || e);
  process.exit(1);
});
