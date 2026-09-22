import type { Db } from "mongodb";
import * as workOrders from "@/lib/data/repositories/protractor-work-orders";
import * as normalizedWorkOrders from "@/lib/data/repositories/normalized-work-orders";
import * as vehicles from "@/lib/data/repositories/vehicles";

export type ProtractorTerminalResult = "applied" | "already_absent";

export const __terminalCallbackDeps = {
  findCachedWorkOrderById: workOrders.findCachedWorkOrderByProviderIdentity,
  markCachedWorkOrderTerminal: workOrders.markCachedWorkOrderTerminal,
  findNormalizedReference: normalizedWorkOrders.findProtractorWorkOrderReference,
  findVehicleReference: vehicles.findVehicleByProtractorWorkOrder,
  removeVehicleSource: vehicles.removeProtractorWorkOrderSource,
};

/**
 * Applies the durable local effects of a terminal POST callback. Kept outside
 * the route so an allowed queue worker can faithfully replay a callback that a
 * denied replica only acknowledged.
 */
export async function applyProtractorTerminalCallback(
  db: Db,
  fields: { shopId: number | string; workOrderId: string; status: string | null },
): Promise<ProtractorTerminalResult> {
  const shopId = Number(fields.shopId);
  if (!Number.isFinite(shopId)) throw new Error("Invalid callback shop ID");
  const [existingWorkOrder, normalizedReference, vehicle] = await Promise.all([
    __terminalCallbackDeps.findCachedWorkOrderById(shopId, fields.workOrderId),
    __terminalCallbackDeps.findNormalizedReference(shopId, fields.workOrderId),
    __terminalCallbackDeps.findVehicleReference(shopId, fields.workOrderId),
  ]);
  if (!existingWorkOrder && !normalizedReference && !vehicle) return "already_absent";
  if (!existingWorkOrder && normalizedReference) {
    throw new Error("Terminal callback local stores are inconsistent");
  }

  const now = new Date();
  if (vehicle) {
    await __terminalCallbackDeps.removeVehicleSource(
      vehicle,
      shopId,
      fields.workOrderId,
      now,
    );
  }
  if (existingWorkOrder) {
    await __terminalCallbackDeps.markCachedWorkOrderTerminal(
      shopId,
      existingWorkOrder,
      fields.status,
      now,
    );
  }
  await db.collection("dashboard_updates").updateOne(
    { _id: "lastUpdate" } as any,
    { $set: { timestamp: Date.now() } },
    { upsert: true },
  );
  return "applied";
}