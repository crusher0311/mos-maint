import type { Db } from "mongodb";
import * as callbackEvents from "@/lib/data/repositories/protractor-callback-events";
import { getProtractorOutboundPolicy, runWithProtractorCallbackTransport } from "./client";
import { logProtractorPolicyDenial } from "./outbound-policy.cjs";

const CALLBACK_CANDIDATE_MULTIPLIER = 10;
const TERMINAL_OPERATIONS = new Set([
  "DELETE",
  "INVOICED",
  "INVOICE",
  "CLOSED",
  "VOID",
]);

function eventTime(item: callbackEvents.PendingGetEvent): number {
  return item.receivedAt?.getTime() ?? 0;
}

function isTerminal(item: callbackEvents.PendingGetEvent): boolean {
  return TERMINAL_OPERATIONS.has(String(item.operation || "").trim().toUpperCase());
}

/**
 * Collapse a candidate window to one event per object, with terminal state
 * dominating later non-terminal noise, then interleave shops round-robin.
 */
export function selectFairCallbackBatch(
  candidates: callbackEvents.PendingGetEvent[],
  limit: number,
): {
  selected: callbackEvents.PendingGetEvent[];
  coalesced: callbackEvents.PendingGetEvent[];
} {
  const winners = new Map<string, callbackEvents.PendingGetEvent>();
  const coalesced: callbackEvents.PendingGetEvent[] = [];
  for (const item of candidates) {
    const identity = JSON.stringify([
      Number(item.shopId),
      item.objectType,
      item.objectId,
    ]);
    const prior = winners.get(identity);
    if (!prior) {
      winners.set(identity, item);
      continue;
    }
    const itemWins =
      (isTerminal(item) && !isTerminal(prior)) ||
      (isTerminal(item) === isTerminal(prior) && eventTime(item) >= eventTime(prior));
    if (itemWins) {
      coalesced.push(prior);
      winners.set(identity, item);
    } else {
      coalesced.push(item);
    }
  }

  const byShop = new Map<number, callbackEvents.PendingGetEvent[]>();
  for (const item of winners.values()) {
    const shopId = Number(item.shopId);
    const queue = byShop.get(shopId) ?? [];
    queue.push(item);
    byShop.set(shopId, queue);
  }
  for (const queue of byShop.values()) {
    queue.sort((a, b) => eventTime(a) - eventTime(b));
  }

  const selected: callbackEvents.PendingGetEvent[] = [];
  const shopIds = [...byShop.keys()];
  while (selected.length < limit) {
    let added = false;
    for (const shopId of shopIds) {
      const item = byShop.get(shopId)?.shift();
      if (!item) continue;
      selected.push(item);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return { selected, coalesced };
}

export async function processProtractorCallbackQueue(
  db: Db,
  dispatch: (item: callbackEvents.PendingGetEvent) => Promise<void>,
  options: {
    limit?: number;
    maxAttempts?: number;
    budgetMs?: number;
    isShopEligible: (shopId: number) => Promise<boolean>;
    acquireBudgetSlot?: () => Promise<boolean>;
  },
): Promise<{ processed: number; failed: number }> {
  const outboundPolicy = getProtractorOutboundPolicy();
  if (!outboundPolicy.allowed) {
    logProtractorPolicyDenial(outboundPolicy, "protractor_callback_queue");
    return { processed: 0, failed: 0 };
  }
  const limit = Math.min(options.limit ?? 45, 45);
  const candidates = await callbackEvents.findPendingGetEvents(
    Math.min(5000, Math.max(limit * CALLBACK_CANDIDATE_MULTIPLIER, limit * 100)),
    options.maxAttempts ?? 3,
    limit,
    outboundPolicy.callbackNotBeforeMs != null
      ? new Date(outboundPolicy.callbackNotBeforeMs)
      : undefined,
  );
  const { selected: pending } = selectFairCallbackBatch(candidates, limit);
  let processed = 0;
  let failed = 0;
  const started = Date.now();
  const deadlineMs = started + (options.budgetMs ?? 180_000);
  for (const item of pending) {
    if (Date.now() - started > (options.budgetMs ?? 180_000)) break;
    const acquire = options.acquireBudgetSlot ?? (async () => true);
    let budgetClaimed = await acquire();
    // A shared token collision is not exhaustion. Keep waiting for the next
    // durable slot inside this invocation rather than dropping the remainder
    // of a batch at a wall-clock boundary. Injectable test seams retain their
    // one-shot semantics for deterministic exhaustion tests.
    if (!budgetClaimed) break;
    const shopId = Number(item.shopId);
    if (
      (
        !Number.isSafeInteger(shopId) ||
        shopId <= 0 ||
        !(await options.isShopEligible(shopId))
      )
    ) {
      await callbackEvents.markProcessed(item.key, { noAction: true });
      continue;
    }
    const identity = item.objectType && item.objectId ? {
      shopId,
      method: item.method,
      objectType: item.objectType,
      objectId: item.objectId,
      // Admission is object-scoped rather than operation-scoped so two
      // replicas cannot concurrently apply Update and terminal Delete.
      operation: "*",
      terminal: isTerminal(item),
    } : null;
    let admitted = false;
    let ownerToken: string | null = null;
    try {
      if (identity) {
        ownerToken = await callbackEvents.claimCallbackEvent(item.key, identity);
        admitted = ownerToken !== null;
        if (!admitted) continue;
      }
      await callbackEvents.recordProcessingStarted(item.key);
      await runWithProtractorCallbackTransport(
        deadlineMs,
        () => dispatch(item),
      );
      if (Date.now() >= deadlineMs) throw new Error("Callback deadline elapsed before completion");
      if (!ownerToken) throw new Error("Callback completion missing owner token");
      const completed = await callbackEvents.completeCallbackGeneration(item.key, identity ?? {
        shopId,
        method: item.method,
        objectType: item.objectType!,
        objectId: item.objectId!,
        operation: "*",
        terminal: isTerminal(item),
      }, ownerToken, item.receivedAt ?? new Date(0));
      if (!completed) throw new Error("Callback completion fence rejected stale owner");
      await callbackEvents.markCallbackShopSuccessfullyServed(shopId, item.key);
      processed++;
    } catch (error: any) {
      await callbackEvents.recordError(item.key, error?.message || String(error));
      failed++;
    } finally {
      if (admitted && identity) {
        await callbackEvents.releaseCallbackEventAdmission(item.key, identity, ownerToken ?? undefined);
      }
    }
  }
  return { processed, failed };
}