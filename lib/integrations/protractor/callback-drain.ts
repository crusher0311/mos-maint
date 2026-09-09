import type { Db } from "mongodb";
import * as callbackEvents from "@/lib/data/repositories/protractor-callback-events";
import { processProtractorCallbackQueue } from "./callback-queue";
import { fetchVehicleById, fetchWorkOrderById } from "./client";
import { upsertProtractorVehicleSnapshot, upsertProtractorWorkOrderSnapshot } from "@/lib/integrations/protractor";
import { applyProtractorTerminalCallback } from "./callback-terminal";
import {
  CALLBACK_REPLAY_FETCH_OPTIONS,
  replayDeferredTerminalPost,
} from "./callback-replay";
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";
import { attributeRevenueFromWorkOrder } from "@/lib/enterprise";
import { extractJobIndexFromWorkOrder, computeJobHash } from "@/lib/job-index";
import { isProtractorShopRecord } from "./shop-eligibility";

const TERMINAL = new Set(["DELETE", "INVOICED", "INVOICE", "CLOSED", "VOID"]);
const CALLBACK_DRAIN_BUDGET_MS = 15_000;

/**
 * Library-owned callback replay. Keeping this out of route modules lets the
 * minute scheduler and tests use exactly the same durable worker.
 */
export async function processProtractorCallbackDrain(db?: Db, options: { budgetMs?: number } = {}) {
  const queueDb = db ?? await callbackEvents.getCallbackQueueDb();
  return processProtractorCallbackQueue(queueDb, async (item) => {
    const operation = String(item.operation || "").toUpperCase();
    if (item.objectType === "WorkOrder" && item.objectId && operation === "DELETE") {
      const applied = await applyProtractorTerminalCallback(queueDb, {
        shopId: item.shopId,
        workOrderId: item.objectId,
        status: "Deleted",
      });
      if (!applied) throw new Error("Terminal callback references an unknown work order");
      return;
    }
    if (item.method === "POST" && item.objectId && TERMINAL.has(operation)) {
      const replayed = await replayDeferredTerminalPost(queueDb, {
        key: item.key,
        shopId: item.shopId,
        objectId: item.objectId,
        operation,
      });
      if (!replayed) throw new Error("Deferred terminal POST replay failed");
      return;
    }
    if (item.objectType === "ServiceItem" && item.objectId) {
      const result = await fetchVehicleById(item.shopId, item.objectId, {
        ...CALLBACK_REPLAY_FETCH_OPTIONS,
      });
      if (!result.ok || !result.vehicle?.VIN) throw new Error(`Vehicle callback replay failed: ${result.error || "missing data"}`);
      await upsertProtractorVehicleSnapshot(item.shopId, result.vehicle.VIN, result.vehicle);
      return;
    }
    if (item.objectType === "WorkOrder" && item.objectId) {
      const result = await fetchWorkOrderById(item.shopId, item.objectId, {
        ...CALLBACK_REPLAY_FETCH_OPTIONS,
      });
      if (!result.ok || !result.workOrder) throw new Error(`Work-order callback replay failed: ${result.error || "missing data"}`);
      await upsertProtractorWorkOrderSnapshot(item.shopId, result.workOrder);
      try {
        const shop = await queueDb.collection("shops").findOne(
          { shopId: { $in: [String(item.shopId), Number(item.shopId)] } },
          { projection: { enterpriseId: 1 } },
        );
        await new NormalizedIngestionService(
          queueDb,
          "protractor",
          item.shopId,
          shop?.enterpriseId as string | undefined,
          { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true, ingestionVia: "webhook-queue-replay" },
        ).ingestWorkOrderWithAllEntities(result.workOrder);
      } catch (error: any) {
        console.error(`[Queue] Normalization error for WO ${item.objectId}:`, error?.message || error);
      }
      const stage = String(result.workOrder.WorkflowStage || "").toLowerCase();
      const completed = result.workOrder.Completed ||
        ["invoiced", "invoice", "posted", "completed", "closed"].some((value) => stage.includes(value));
      const vin = String(result.workOrder.ServiceItem?.VIN || result.workOrder.ServiceItem?.Lookup || "").toUpperCase();
      if (completed && vin) {
        const saved = await queueDb.collection("protractor_work_orders").findOne({
          shopId: item.shopId,
          workOrderId: item.objectId,
        });
        if (saved?.packageSummaries?.length) {
          try {
            await attributeRevenueFromWorkOrder(
              item.shopId,
              item.objectId,
              vin,
              saved.packageSummaries,
              "protractor",
            );
          } catch {
            // Revenue attribution remains non-critical.
          }
        }
        try {
          for (const entry of extractJobIndexFromWorkOrder(item.shopId, result.workOrder, "protractor")) {
            const filter = {
              shopId: item.shopId,
              workOrderId: entry.workOrderId,
              servicePackageId: entry.servicePackageId,
            };
            const existing = await queueDb.collection("job_index").findOne(filter);
            const contentHash = computeJobHash(entry);
            if (existing?.contentHash !== contentHash) {
              await queueDb.collection("job_index").updateOne(
                filter,
                { $set: { ...entry, contentHash } },
                { upsert: true },
              );
            }
          }
          await queueDb.collection("protractor_work_orders").updateMany(
            { shopId: { $in: [String(item.shopId), Number(item.shopId)] }, workOrderId: item.objectId },
            { $set: { jobsIndexed: true, jobsIndexedAt: new Date() } },
          );
        } catch (error) {
          console.error(`[Queue] Job indexing error for WO ${item.objectId}:`, error);
        }
      }
      return;
    }
    throw new Error("Callback event has no replayable object");
  }, {
    limit: 45,
    maxAttempts: 3,
    // Leave ample room under the scheduler's 50s request timeout for the
    // final provider response and local persistence to finish cleanly.
    budgetMs: options.budgetMs ?? CALLBACK_DRAIN_BUDGET_MS,
    isShopEligible: async (shopId) => isProtractorShopRecord(
      await queueDb.collection("shops").findOne({
        shopId: { $in: [shopId, String(shopId)] },
      }),
    ),
  });
}