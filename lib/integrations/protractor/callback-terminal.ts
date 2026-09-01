import type { Db } from "mongodb";
import * as callbackEvents from "@/lib/data/repositories/protractor-callback-events";

/**
 * Applies the durable local effects of a terminal POST callback. Kept outside
 * the route so an allowed queue worker can faithfully replay a callback that a
 * denied replica only acknowledged.
 */
export async function applyProtractorTerminalCallback(
  db: Db,
  fields: { shopId: number | string; workOrderId: string; status: string | null },
): Promise<boolean> {
  const existingWorkOrder = await db.collection("protractor_work_orders").findOne({
    $or: [{ shopId: String(fields.shopId) }, { shopId: Number(fields.shopId) }],
    workOrderGuid: fields.workOrderId,
  });
  if (!existingWorkOrder) return false;

  const vehicle = await db.collection("vehicles").findOne({
    $or: [{ shopId: String(fields.shopId) }, { shopId: Number(fields.shopId) }],
    "status.active": true,
    "status.sources": {
      $elemMatch: { provider: "protractor", workOrderId: fields.workOrderId },
    },
  });
  if (vehicle) {
    const updatedSources = (vehicle.status?.sources || []).filter(
      (s: any) => !(s.provider === "protractor" && String(s.workOrderId) === String(fields.workOrderId)),
    );
    const hasActiveSources = updatedSources.length > 0;
    await db.collection("vehicles").updateOne(
      { _id: vehicle._id },
      {
        $set: {
          "status.active": hasActiveSources,
          "status.sources": updatedSources,
          ...(hasActiveSources ? {} : { "status.lastClosedAt": new Date() }),
          updatedAt: new Date(),
        },
      },
    );
  }

  await db.collection("protractor_work_orders").updateMany(
    { workOrderGuid: fields.workOrderId },
    {
      $set: {
        workflowStage: fields.status,
        status: fields.status,
        closedAt: new Date(),
        closedViaCallback: true,
        updatedAt: new Date(),
      },
    },
  );
  await callbackEvents.markOneProcessedByWorkOrderStatus(fields.workOrderId, fields.status);
  await db.collection("dashboard_updates").updateOne(
    { _id: "lastUpdate" } as any,
    { $set: { timestamp: Date.now() } },
    { upsert: true },
  );
  return true;
}