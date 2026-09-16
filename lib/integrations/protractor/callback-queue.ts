import type { Db } from "mongodb";
import * as callbackEvents from "@/lib/data/repositories/protractor-callback-events";
import {
  getEffectiveProtractorOutboundPolicy,
  isProtractorRelayTransportConfigured,
  runWithProtractorCallbackTransport,
} from "./client";
import { logProtractorPolicyDenial } from "./outbound-policy.cjs";
import { isCallbackSafetyBoundary, type CallbackHistoryOutcome } from "./callback-outcomes";
import { callbackEventWins, isTerminalCallbackEvent } from "./callback-selection";
import {
  createCallbackTimingRecorder,
  emitCallbackBatchTiming,
  emitCallbackStageTiming,
  type CallbackTimingOutcome,
  type CallbackTimingRecorder,
  type CallbackBatchExitReason,
} from "./callback-timing";

const CALLBACK_CANDIDATE_MULTIPLIER = 10;
function eventTime(item: callbackEvents.PendingGetEvent): number {
  return item.receivedAt?.getTime() ?? 0;
}

function isTerminal(item: callbackEvents.PendingGetEvent): boolean {
  return isTerminalCallbackEvent(item);
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
    const itemWins = callbackEventWins(item, prior);
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
  dispatch: (
    item: callbackEvents.PendingGetEvent,
    timing?: CallbackTimingRecorder,
  ) => Promise<CallbackHistoryOutcome | void>,
  options: {
    limit?: number;
    maxAttempts?: number;
    budgetMs?: number;
    /** Optional invocation deadline so setup/selection cannot extend a short cron budget. */
    deadlineAtMs?: number;
    isShopEligible: (shopId: number) => Promise<boolean>;
    acquireBudgetSlot?: () => Promise<boolean>;
  },
): Promise<{ processed: number; failed: number }> {
  const batchStartedAt = Date.now();
  let candidateCount = 0;
  let selectedCount = 0;
  let selectionCollapsedCount = 0;
  let processed = 0;
  let failed = 0;
  let exitReason: CallbackBatchExitReason = "completed";

  try {
    const outboundPolicy = await getEffectiveProtractorOutboundPolicy();
    if (!outboundPolicy.allowed) {
      logProtractorPolicyDenial(outboundPolicy, "protractor_callback_queue");
      emitCallbackStageTiming("selection", 0, "skipped");
      exitReason = "policy_denied";
      return { processed: 0, failed: 0 };
    }
    // Do not claim/retry callback rows on a replica that cannot satisfy
    // a shared relay-only generation. Physical dispatch independently verifies
    // the same invariant, but queue admission must not create partial durable
    // work while another replica is live.
    if (outboundPolicy.relayRequired === true && !isProtractorRelayTransportConfigured()) {
      logProtractorPolicyDenial(
        { ...outboundPolicy, allowed: false, reason: "relay_required_unavailable" },
        "protractor_callback_queue",
      );
      emitCallbackStageTiming("selection", 0, "skipped");
      exitReason = "relay_unavailable";
      return { processed: 0, failed: 0 };
    }
    const limit = Math.min(options.limit ?? 45, 45);
    const selectionStartedAt = Date.now();
    let candidates: callbackEvents.PendingGetEvent[];
    let selectionSucceeded = false;
    try {
      candidates = await callbackEvents.findPendingGetEvents(
        Math.min(5000, Math.max(limit * CALLBACK_CANDIDATE_MULTIPLIER, limit * 100)),
        options.maxAttempts ?? 3,
        limit,
        outboundPolicy.callbackNotBeforeMs != null
          ? new Date(outboundPolicy.callbackNotBeforeMs)
          : undefined,
      );
      // Query exact authoritative winners only for a fixed fair subset, not
      // for all 4,500 candidates. A rejected/exhausted winner is removed
      // before the final 45 are chosen; no callback row is changed here.
      const preselection = selectFairCallbackBatch(
        candidates,
        Math.min(candidates.length, limit * 6),
      );
      const authorityFiltered = await callbackEvents.filterPendingCallbackCandidatesByAuthority(
        preselection.selected,
        outboundPolicy.callbackNotBeforeMs != null
          ? new Date(outboundPolicy.callbackNotBeforeMs)
          : undefined,
      );
      const selection = selectFairCallbackBatch(authorityFiltered, limit);
      candidateCount = candidates.length;
      selectedCount = selection.selected.length;
      // This is only the in-memory duplicate collapse performed while
      // selecting the batch; it is not durable coalescing.
      selectionCollapsedCount = preselection.coalesced.length + selection.coalesced.length;
      emitCallbackStageTiming(
        "selection",
        Date.now() - selectionStartedAt,
        "success",
      );
      selectionSucceeded = true;
      const { selected: pending } = selection;
      // Preserve relative budgets for existing callers. Short cron callers
      // can additionally cap the deadline from the start of their invocation.
      const started = Date.now();
      const deadlineMs = Math.min(
        started + (options.budgetMs ?? 180_000),
        options.deadlineAtMs ?? Infinity,
      );
      let admittedWork = 0;
      for (const item of pending) {
        if (admittedWork >= limit) break;
        if (Date.now() >= deadlineMs) {
          exitReason = "deadline";
          break;
        }
        const timing = createCallbackTimingRecorder();
        let timingOutcome: CallbackTimingOutcome = "failed";
        try {
          const acquire = options.acquireBudgetSlot ?? (async () => true);
          // A shared token collision is not exhaustion. Keep waiting for the
          // next durable slot inside this invocation rather than dropping the
          // remainder of a batch at a wall-clock boundary. Injectable test
          // seams retain their one-shot semantics for deterministic exhaustion
          // tests.
          const budgetClaimed = await acquire();
          if (Date.now() >= deadlineMs) {
            exitReason = "deadline";
            timingOutcome = "skipped";
            timing.mark("claim", 0, "skipped");
            break;
          }
          if (!budgetClaimed) {
            exitReason = "budget_unavailable";
            timingOutcome = "skipped";
            timing.mark("claim", 0, "skipped");
            break;
          }
          const shopId = Number(item.shopId);
          const eligibilityStartedAt = timing.start("eligibility");
          let eligible = false;
          try {
            eligible = (
              !Number.isSafeInteger(shopId) || shopId <= 0
            ) ? false : await options.isShopEligible(shopId);
            timing.finish("eligibility", eligibilityStartedAt, eligible ? "success" : "skipped");
          } catch (error) {
            timing.finish("eligibility", eligibilityStartedAt, "failed");
            throw error;
          }
          // Pre-admission waits must not start an event after the deadline.
          // Once claimed below, retain the existing durable completion path.
          if (Date.now() >= deadlineMs) {
            exitReason = "deadline";
            timingOutcome = "skipped";
            timing.mark("claim", 0, "skipped");
            break;
          }
          if (!eligible) {
            await callbackEvents.markProcessed(item.key, {
              noAction: true,
              historyOutcome: { category: "terminal_no_history", reason: "ineligible" },
            });
            timing.mark("claim", 0, "skipped");
            timing.mark("completion", 0, "success");
            timingOutcome = "success";
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
          let attemptStarted = false;
          let returnedOutcome: CallbackHistoryOutcome | void = undefined;
          try {
            const claimStartedAt = timing.start("claim");
            try {
              if (identity) {
                ownerToken = await callbackEvents.claimCallbackEvent(
                  item.key,
                  identity,
                  outboundPolicy.callbackNotBeforeMs != null
                    ? new Date(outboundPolicy.callbackNotBeforeMs)
                    : undefined,
                  options.maxAttempts ?? 3,
                );
                admitted = ownerToken !== null;
                timing.finish("claim", claimStartedAt, admitted ? "success" : "skipped");
                if (!admitted) {
                  timingOutcome = "skipped";
                  continue;
                }
                admittedWork++;
              } else {
                timing.mark("claim", 0, "skipped");
                admittedWork++;
              }
            } catch (error) {
              timing.finish("claim", claimStartedAt, "failed");
              throw error;
            }
            if (item.objectType === "Contact" && ownerToken) {
              // Retain the notification as unresolved customer-sync work. No
              // Contact replay handler exists: do not burn three attempts,
              // coalesce it as applied history, or discard its payload.
              await callbackEvents.recordCallbackOutcome(item.key, ownerToken, {
                category: "deferred", reason: "unsupported_contact",
              });
              timingOutcome = "deferred";
              continue;
            }
            await callbackEvents.recordProcessingStarted(item.key);
            attemptStarted = true;
            // This stage includes callback transport admission and the
            // callback dispatch function. Nested fetch/snapshot/normalization
            // stages are intentionally non-additive with dispatch.
            const dispatchStartedAt = timing.start("dispatch");
            try {
              returnedOutcome = await runWithProtractorCallbackTransport(
                deadlineMs,
                () => dispatch(item, timing),
                // This is the timestamp persisted by insertGetEvent. Never
                // replace it with the queue worker's clock: the staged trial's
                // activation floor is based on when Protractor delivered it.
                {
                  callbackReceivedAt: item.receivedAt,
                  requireTimedTrial: outboundPolicy.requireTimedTrial === true,
                },
              );
              timing.finish(
                "dispatch",
                dispatchStartedAt,
                "success",
              );
            } catch (error) {
              timing.finish("dispatch", dispatchStartedAt, "failed");
              throw error;
            }
            // The batch deadline stops new provider work, not durable evidence
            // of work already performed. Completion still requires both owner
            // fences.
            if (!ownerToken) throw new Error("Callback completion missing owner token");
            // A vehicle without a VIN used to throw "missing data"; keep its
            // three attempts and replay eligibility while recording the specific
            // cause. Do not change historical non-critical indexing behavior.
            if (item.objectType === "ServiceItem" &&
                returnedOutcome?.category === "failed" && returnedOutcome.reason === "missing_vin") {
              await callbackEvents.recordCallbackOutcome(item.key, ownerToken, returnedOutcome);
              await callbackEvents.recordError(item.key, `Callback replay failed: ${returnedOutcome.reason}`, ownerToken);
              failed++;
              timingOutcome = "failed";
              continue;
            }
            const completionStartedAt = timing.start("completion");
            try {
              const completed = await callbackEvents.completeCallbackGeneration(item.key, identity ?? {
                shopId,
                method: item.method,
                objectType: item.objectType!,
                objectId: item.objectId!,
                operation: "*",
                terminal: isTerminal(item),
              }, ownerToken, item.receivedAt ?? new Date(0), returnedOutcome || {
                category: "deferred", reason: "unverified",
              }, outboundPolicy.callbackNotBeforeMs != null
                ? new Date(outboundPolicy.callbackNotBeforeMs)
                : undefined);
              if (!completed) throw new Error("Callback completion fence rejected stale owner");
              await callbackEvents.markCallbackShopSuccessfullyServed(shopId, item.key);
              timing.finish("completion", completionStartedAt, "success");
              processed++;
              timingOutcome = "success";
            } catch (error) {
              timing.finish("completion", completionStartedAt, "failed");
              throw error;
            }
          } catch (error: any) {
            if (ownerToken && attemptStarted && isCallbackSafetyBoundary(error)) {
              await callbackEvents.recordCallbackDeferral(item.key, ownerToken, {
                category: "deferred", reason: "safety_boundary",
              });
              timingOutcome = "deferred";
              continue;
            }
            if (ownerToken) {
              // If durable completion fails, retain actual dispatch evidence
              // when this generation is still ours. Never replace it with
              // dispatch_failed.
              await callbackEvents.recordCallbackOutcome(item.key, ownerToken, returnedOutcome || {
                category: "failed", reason: "dispatch_failed",
              });
            }
            await callbackEvents.recordError(item.key, error?.message || String(error), ownerToken ?? undefined);
            failed++;
            timingOutcome = "failed";
          } finally {
            if (admitted && identity) {
              await callbackEvents.releaseCallbackEventAdmission(item.key, identity, ownerToken ?? undefined);
            }
          }
        } finally {
          timing.finalize(timingOutcome);
        }
      }
    } catch (error) {
      if (!selectionSucceeded) {
        emitCallbackStageTiming(
          "selection",
          Date.now() - selectionStartedAt,
          "failed",
        );
      }
      exitReason = "failed";
      throw error;
    }
    if (selectedCount === 0) exitReason = "empty";
    return { processed, failed };
  } finally {
    emitCallbackBatchTiming({
      durationMs: Date.now() - batchStartedAt,
      candidateCount,
      selectedCount,
      selectionCollapsedCount,
      processed,
      failed,
      exitReason,
    });
  }
}