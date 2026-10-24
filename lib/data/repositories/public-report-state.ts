import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/data/db";
import { publicVehicleKey, readCustomerMileage } from "@/lib/customer-mileage-store";
import type { CustomerMileageAnchor } from "@/lib/public-report-mileage";
import { findLatestCachedPlanDoc } from "@/lib/data/repositories/plan-cache-store";
import { resolveOpenRoMileage } from "@/lib/plan-build/open-ro-mileage";

// Optional store preserves existing injected, offline callers.
export async function readPublicMileageAnchor(shopId: number, vin: string, db?: any) {
  return readCustomerMileage(db ?? await getDb(), shopId, vin);
}

export async function findPublicReportShop(shopId: number, db?: any) {
  return (db ?? await getDb()).collection("shops").findOne({ $or: [{ shopId }, { shopId: String(shopId) }] });
}

export async function loadPublicMileageContext(shopId: number, vin: string) {
  const db = await getDb();
  const [shop, cached, vehicle] = await Promise.all([
    findPublicReportShop(shopId, db),
    findLatestCachedPlanDoc(shopId, vin, db),
    db.collection("vehicles").findOne({ vin, shopId: { $in: [shopId, String(shopId)] } }, { maxTimeMS: 1500 }),
  ]);
  const ro = shop && cached?.plan
    ? await resolveOpenRoMileage({ db, shopIdVariants: [shopId, String(shopId)], vin, provider: shop.integrationProvider })
    : null;
  return { shop, cached, vehicle, ro };
}

export async function findPublicMileageState(shopId: number, vin: string, db?: any) {
  return (db ?? await getDb()).collection("public_report_state").findOne({ _id: publicVehicleKey(shopId, vin) }, { maxTimeMS: 1500 });
}

export async function claimPublicMileageRefresh(shopId: number, vin: string, now: Date, refreshAfter: Date, db?: any) {
  return (db ?? await getDb()).collection("public_report_state").updateOne(
    { _id: publicVehicleKey(shopId, vin), $or: [{ refreshAfter: { $exists: false } }, { refreshAfter: { $lte: now } }] },
    { $set: { refreshAfter } }, { upsert: true, maxTimeMS: 1500 },
  );
}

export async function completePublicMileageRefresh(shopId: number, vin: string, revision: string, db?: any) {
  return (db ?? await getDb()).collection("public_report_state").updateOne(
    { _id: publicVehicleKey(shopId, vin), pendingMileageRevision: revision },
    { $unset: { pendingMileageRevision: "" } }, { maxTimeMS: 1500 },
  );
}

export async function findPendingPublicMileageRefresh() {
  const db = await getDb();
  await db.collection("public_report_state").createIndex(
    { refreshAfter: 1 },
    { name: "pending_public_mileage_refresh", partialFilterExpression: { pendingMileageRevision: { $exists: true } } },
  );
  return db.collection("public_report_state").findOne({
    pendingMileageRevision: { $exists: true },
    $or: [{ refreshAfter: { $exists: false } }, { refreshAfter: { $lte: new Date() } }],
  }, { sort: { refreshAfter: 1 }, maxTimeMS: 1500 });
}

export async function deferPublicMileageRefresh(state: any, refreshAfter: Date) {
  const db = await getDb();
  return db.collection("public_report_state").updateOne(
    { _id: state._id, pendingMileageRevision: state.pendingMileageRevision },
    { $set: { refreshAfter } },
  );
}

export async function writePublicCustomerMileage(shopId: number, vin: string, anchor: CustomerMileageAnchor, db?: any) {
  return (db ?? await getDb()).collection("public_report_state").updateOne(
    { _id: publicVehicleKey(shopId, vin), $or: [{ customerMileage: { $exists: false } }, { "customerMileage.mileage": { $lte: anchor.mileage } }] },
    { $set: { customerMileage: anchor, shopId, vin, pendingMileageRevision: randomUUID() } },
    { upsert: true, maxTimeMS: 1500 },
  );
}
