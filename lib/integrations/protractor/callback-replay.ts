import type { Db } from "mongodb";
import {
  fetchWorkOrderById,
  upsertProtractorWorkOrderSnapshot,
} from "@/lib/integrations/protractor";
import * as callbackEvents from "@/lib/data/repositories/protractor-callback-events";
import { applyProtractorTerminalCallback } from "./callback-terminal";

export const TERMINAL_CALLBACK_STATUSES = new Set([
  "INVOICED",
  "INVOICE",
  "CLOSED",
  "VOID",
]);

export interface DeferredTerminalPost {
  key: string;
  shopId: number;
  objectId: string;
  operation: string | null;
}

/**
 * Replays the complete terminal-POST path on an allowed replica. Dependencies
 * are injectable so the behavior can be exercised without any live stores.
 */
export async function replayDeferredTerminalPost(
  db: Db,
  event: DeferredTerminalPost,
  deps = {
    fetchWorkOrderById,
    upsertProtractorWorkOrderSnapshot,
    applyProtractorTerminalCallback,
    markProcessed: callbackEvents.markProcessed,
  },
): Promise<boolean> {
  const result = await deps.fetchWorkOrderById(event.shopId, event.objectId);
  if (!result.ok || !result.workOrder) return false;
  await deps.upsertProtractorWorkOrderSnapshot(event.shopId, result.workOrder);
  const applied = await deps.applyProtractorTerminalCallback(db, {
    shopId: event.shopId,
    workOrderId: event.objectId,
    status: event.operation,
  });
  if (!applied) return false;
  await deps.markProcessed(event.key);
  return true;
}