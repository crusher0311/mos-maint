/**
 * Task #477 read-only verification probe.
 *
 * Exercises the exact mileage-resolution waterfall the partner VHI
 * endpoints (GET /api/external/vehicles/[vin]/vhi and POST
 * /api/external/vhi/analyze) now run, against live data, WITHOUT needing a
 * partner API key or writing anything.
 *
 * Expected for VIN 2HKRM4H55EH704109 (RO #36709): open-RO odometer 111,961
 * wins over the stale vehicles-collection snapshot.
 *
 * Run: npx tsx scripts/probe-vhi-477-open-ro.ts [VIN] [RO#]
 */

import { ObjectId } from "mongodb";
import { getDb } from "../lib/mongo";
import { resolveOpenRoMileage, pickMileageInput } from "../lib/plan-build/open-ro-mileage";
import { resolveMileageFromRo } from "../lib/vhi-rebuild";

const VIN = (process.argv[2] || "2HKRM4H55EH704109").toUpperCase();
const RO = process.argv[3] || "36709";

async function main() {
  const db = await getDb();

  // Locate the shop that owns this VIN's ROs (tekmetric mirror).
  const wo = await db.collection("tekmetric_work_orders").findOne(
    { vin: VIN },
    // Task #960: mirror docs may only carry Tekmetric's updatedDate.
    { projection: { shopId: 1, workOrderNumber: 1 }, sort: { updatedAt: -1, updatedDate: -1 } }
  );
  if (!wo) {
    console.error(`No tekmetric_work_orders row for VIN ${VIN}`);
    process.exit(1);
  }
  const shopId = Number(wo.shopId);
  console.log(`VIN ${VIN} → shopId ${shopId} (latest WO #${wo.workOrderNumber})`);

  // Same shopIdVariants construction as the routes.
  const shopRecord = await db.collection("shops").findOne(
    { shopId: { $in: [String(shopId), Number(shopId)] } },
    { projection: { _id: 1, integrationProvider: 1 } }
  );
  const shopIdVariants: any[] = [String(shopId), Number(shopId)];
  if (shopRecord?._id) {
    shopIdVariants.push(shopRecord._id, String(shopRecord._id));
    try {
      shopIdVariants.push(new ObjectId(String(shopRecord._id)));
    } catch { /* ignore */ }
  }
  const provider = shopRecord?.integrationProvider ?? "tekmetric";
  console.log(`provider=${provider}`);

  // Vehicles-collection snapshot (what partners were being served before).
  const vehicleDoc = await db.collection("vehicles").findOne(
    { shopId: { $in: shopIdVariants }, vin: { $in: [VIN] } },
    { projection: { currentMileage: 1, lastMileage: 1, mileage: 1, odometer: 1 } }
  );
  const raw =
    vehicleDoc?.currentMileage ?? vehicleDoc?.lastMileage ?? vehicleDoc?.mileage ?? vehicleDoc?.odometer ?? null;
  const vehicleDocMileage = raw && Number(raw) > 0 ? Number(raw) : null;
  console.log(`vehicles-collection snapshot mileage: ${vehicleDocMileage}`);

  // (1a) roNumber-specific lookup (analyze route path).
  const roMiles = await resolveMileageFromRo(db, shopId, provider, VIN, RO);
  console.log(`resolveMileageFromRo(RO #${RO}): ${roMiles}`);

  // (1b) most-recent open-RO lookup (GET route path).
  const openRoLookup = await resolveOpenRoMileage({ db, shopIdVariants, vin: VIN, provider });
  console.log(`resolveOpenRoMileage: ${JSON.stringify(openRoLookup)}`);

  // Monotonic pick — what the routes serve.
  const picked = pickMileageInput({ openRoLookup, vehicleDocMileage });
  console.log(`pickMileageInput → miles=${picked.miles} source=${picked.mileageInputSource}`);

  // The ticket cited 111,961 mi, but the live RO odometer moves over time —
  // the durable assertions are: (a) the RO-specific lookup returns the same
  // reading as the open-RO helper, and (b) the waterfall serves the open-RO
  // reading (not the stale vehicles snapshot) with source "open_ro".
  const openRoMiles = openRoLookup?.miles ?? null;
  const passRo = roMiles != null && Number(roMiles) === openRoMiles;
  const passPick =
    picked.miles === openRoMiles &&
    picked.mileageInputSource === "open_ro" &&
    (vehicleDocMileage == null || picked.miles! > vehicleDocMileage);
  console.log(`\nRO-specific lookup agrees with open-RO helper (${openRoMiles}): ${passRo ? "PASS" : "FAIL"}`);
  console.log(`Waterfall serves open-RO reading over stale snapshot (${vehicleDocMileage}): ${passPick ? "PASS" : "FAIL"}`);
  process.exit(passRo && passPick ? 0 : 1);
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
