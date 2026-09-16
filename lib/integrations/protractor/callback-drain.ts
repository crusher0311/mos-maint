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
import { createNormalizationTimingRecorder } from "@/lib/integrations/core/normalization-timing";
import { attributeRevenueFromWorkOrder } from "@/lib/enterprise";
import { indexCallbackHistory } from "./callback-history-index";
import type { CallbackHistoryOutcome } from "./callback-outcomes";
import { isProtractorShopRecord } from "./shop-eligibility";
import type {
  CallbackTimingOutcome,
  CallbackTimingRecorder,
} from "./callback-timing";

const TERMINAL = new Set(["DELETE", "INVOICED", "INVOICE", "CLOSED", "VOID"]);
const CALLBACK_DRAIN_BUDGET_MS = 30_000;

function normalizationCallbackOutcome(
  value: unknown,
): "success" | "failed" | "skipped" {
  try {
    const result = value as {
      workOrder?: { success?: unknown; action?: unknown };
    } | null | undefined;
    if (result?.workOrder?.success === false) return "failed";
    if (result?.workOrder?.action === "skipped") return "skipped";
  } catch {
    // Result inspection is telemetry-only; a malformed shape remains success.
  }
  return "success";
}

/**
 * Library-owned callback replay. Keeping this out of route modules lets the
 * minute scheduler and tests use exactly the same durable worker.
 */
export async function processProtractorCallbackDrain(db?: Db, options: { budgetMs?: number } = {}) {
  const invocationStartedAt = Date.now();
  const queueDb = db ?? await callbackEvents.getCallbackQueueDb();
  // Eligibility is resolved once per queue invocation.  Keep only the
  // allowlisted enterprise identifier needed by normalized ingestion; this is
  // intentionally not a cross-request cache.
  const eligibleShopMetadata = new Map<number, { enterpriseId?: string }>();
  const timedStage = async <T>(
    timing: CallbackTimingRecorder | undefined,
    stage: Exclude<"fetch" | "snapshot" | "normalization" | "indexing" | "attribution" | "secondary_work", "total">,
    work: () => Promise<T>,
    outcomeForResult?: (value: T) => CallbackTimingOutcome,
  ): Promise<T> => {
    if (!timing) return work();
    const startedAt = timing.start(stage);
    try {
      const result = await work();
      timing.finish(stage, startedAt, outcomeForResult?.(result) ?? "success");
      return result;
    } catch (error) {
      timing.finish(stage, startedAt, "failed");
      throw error;
    }
  };

  // Fetch timing covers the client request helper, including its admission
  // wait; it is nested inside the queue's dispatch timing.
  return processProtractorCallbackQueue(queueDb, async (
    item,
    timing,
  ): Promise<CallbackHistoryOutcome> => {
    const operation = String(item.operation || "").toUpperCase();
    if (item.objectType === "WorkOrder" && item.objectId && operation === "DELETE") {
      const applied = await applyProtractorTerminalCallback(queueDb, {
        shopId: item.shopId,
        workOrderId: item.objectId,
        status: "Deleted",
      });
      if (!applied) throw new Error("Terminal callback references an unknown work order");
      return { category: "terminal_no_history", reason: "terminal_applied" };
    }
    if (item.method === "POST" && item.objectId && TERMINAL.has(operation)) {
      const replayed = await timedStage(
        timing,
        "fetch",
        () => replayDeferredTerminalPost(queueDb, {
          key: item.key,
          shopId: item.shopId,
          objectId: item.objectId!,
          operation,
        }),
        (value) => value ? "success" : "failed",
      );
      if (!replayed) throw new Error("Deferred terminal POST replay failed");
      return { category: "terminal_no_history", reason: "terminal_applied" };
    }
    if (item.objectType === "ServiceItem" && item.objectId) {
      const result = await timedStage(
        timing,
        "fetch",
        () => fetchVehicleById(item.shopId, item.objectId!, {
          ...CALLBACK_REPLAY_FETCH_OPTIONS,
        }),
        (value) => value.ok && Boolean(value.vehicle) ? "success" : "failed",
      );
      if (!result.ok || !result.vehicle) throw new Error(`Vehicle callback replay failed: ${result.error || "missing data"}`);
      if (!result.vehicle.VIN) return { category: "failed", reason: "missing_vin" };
      await timedStage(
        timing,
        "snapshot",
        () => upsertProtractorVehicleSnapshot(item.shopId, result.vehicle!.VIN!, result.vehicle!),
      );
      return { category: "terminal_no_history", reason: "vehicle_snapshot" };
    }
    if (item.objectType === "WorkOrder" && item.objectId) {
      const result = await timedStage(
        timing,
        "fetch",
        () => fetchWorkOrderById(item.shopId, item.objectId!, {
          ...CALLBACK_REPLAY_FETCH_OPTIONS,
        }),
        (value) => value.ok && Boolean(value.workOrder) ? "success" : "failed",
      );
      if (!result.ok || !result.workOrder) throw new Error(`Work-order callback replay failed: ${result.error || "missing data"}`);
      await timedStage(
        timing,
        "snapshot",
        () => upsertProtractorWorkOrderSnapshot(item.shopId, result.workOrder!),
      );
      const normalizationTiming = timing
        ? createNormalizationTimingRecorder()
        : undefined;
      let normalizationOutcome: CallbackTimingOutcome = "failed";
      try {
        const normalizationResult = await timedStage(
          timing,
          "normalization",
          () => new NormalizedIngestionService(
            queueDb,
            "protractor",
            item.shopId,
            eligibleShopMetadata.get(Number(item.shopId))?.enterpriseId,
            {
              // The callback replay keeps job-index dual-write disabled.
              // Consequently job_index_lookup/job_index_write and their ACES
              // decode timing labels are intentionally absent here.
              dualWriteToJobIndex: false,
              dualWriteToRepairPatterns: true,
              ingestionVia: "webhook-queue-replay",
              callbackNormalizationTiming: normalizationTiming,
            },
          ).ingestWorkOrderWithAllEntities(result.workOrder!),
          normalizationCallbackOutcome,
        );
        normalizationOutcome = normalizationCallbackOutcome(normalizationResult);
      } catch {
        // Do not include object identifiers or provider error text in logs.
        console.error("[Queue] Callback normalization failed");
        normalizationOutcome = "failed";
      } finally {
        normalizationTiming?.finalize(normalizationOutcome);
      }
      const stage = String(result.workOrder.WorkflowStage || "").toLowerCase();
      const completed = result.workOrder.Completed ||
        ["invoiced", "invoice", "posted", "completed", "closed"].some((value) => stage.includes(value));
      const vin = String(result.workOrder.ServiceItem?.VIN || result.workOrder.ServiceItem?.Lookup || "").toUpperCase();
      if (completed && vin) {
        const attributionStartedAt = timing?.start("attribution");
        let attributionOutcome: CallbackTimingOutcome = "success";
        try {
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
              attributionOutcome = "failed";
            }
          }
          if (timing && attributionStartedAt !== undefined) {
            timing.finish("attribution", attributionStartedAt, attributionOutcome);
          }
        } catch (error) {
          if (timing && attributionStartedAt !== undefined) {
            timing.finish("attribution", attributionStartedAt, "failed");
          }
          throw error;
        }
        const indexingStartedAt = timing?.start("indexing");
        let outcome: CallbackHistoryOutcome;
        try {
          outcome = await indexCallbackHistory(queueDb, item.shopId, result.workOrder);
          if (timing && indexingStartedAt !== undefined) {
            timing.finish("indexing", indexingStartedAt, outcome.category === "failed" ? "failed" : "success");
          }
        } catch (error) {
          if (timing && indexingStartedAt !== undefined) {
            timing.finish("indexing", indexingStartedAt, "failed");
          }
          throw error;
        }
        const secondaryStartedAt = timing?.start("secondary_work");
        try {
          if (outcome.category !== "failed") {
            await queueDb.collection("protractor_work_orders").updateMany(
              { shopId: { $in: [String(item.shopId), Number(item.shopId)] }, workOrderId: item.objectId },
              { $set: { jobsIndexed: true, jobsIndexedAt: new Date() } },
            );
          }
          if (timing && secondaryStartedAt !== undefined) {
            timing.finish("secondary_work", secondaryStartedAt, "success");
          }
        } catch {
          if (timing && secondaryStartedAt !== undefined) {
            timing.finish("secondary_work", secondaryStartedAt, "failed");
          }
          // Snapshot bookkeeping is not evidence of job-index application.
          console.error("[Queue] Callback index marker update failed");
        }
        return outcome;
      }
      return completed
        ? { category: "failed", reason: "missing_vin" }
        : { category: "terminal_no_history", reason: "open_work_order" };
    }
    throw new Error("Callback event has no replayable object");
  }, {
    limit: 45,
    maxAttempts: 3,
    // Stop starting work at 30s, including setup/selection time, leaving
    // nominal 20s headroom under the minute scheduler's 50s timeout.
    // Already-admitted work still finishes durably; this is not an abort.
    // Explicit budgets belong to callers with a different timeout envelope
    // (the full sync route) and retain their existing relative semantics.
    budgetMs: options.budgetMs ?? CALLBACK_DRAIN_BUDGET_MS,
    deadlineAtMs: options.budgetMs === undefined
      ? invocationStartedAt + CALLBACK_DRAIN_BUDGET_MS
      : undefined,
    isShopEligible: async (shopId) => {
      const shop = await queueDb.collection("shops").findOne({
        shopId: { $in: [shopId, String(shopId)] },
      });
      const eligible = isProtractorShopRecord(shop);
      if (eligible) {
        eligibleShopMetadata.set(shopId, {
          enterpriseId: shop?.enterpriseId as string | undefined,
        });
      }
      return eligible;
    },
  });
}