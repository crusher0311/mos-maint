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
const CALLBACK_RECOVERY_CANDIDATE_LIMIT = 270;
const CALLBACK_RECOVERY_RESERVED_SLOTS = 1;
function eventTime(item: callbackEvents.PendingGetEvent): number {
  return item.receivedAt?.getTime() ?? 0;
}

function isTerminal(item: callbackEvents.PendingGetEvent): boolean {
  return isTerminalCallbackEvent(item);
}

function isUnsupportedContact(item: callbackEvents.PendingGetEvent): boolean {
  // Keep this exact-case check aligned with the retained deferral branch below.
  return item.objectType === "Contact";
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
    queue.sort((a, b) => {
      // Recovery rotation is persisted specifically to avoid a repeatedly
      // unclaimable oldest same-shop event monopolizing its reserved slot.
      // Fresh ordering and cross-shop fairness remain unchanged.
      if (a.selectionLane === "recovery" && b.selectionLane === "recovery" &&
          a.recoveryBufferOrder !== undefined && b.recoveryBufferOrder !== undefined) {
        return a.recoveryBufferOrder - b.recoveryBufferOrder;
      }
      return eventTime(a) - eventTime(b);
    });
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
        CALLBACK_RECOVERY_CANDIDATE_LIMIT,
      );
      // Query exact authoritative winners only for a fixed fair subset, not
      // for all 4,500 candidates. A rejected/exhausted winner is removed
      // before the final 45 are chosen; no callback row is changed here.
      // Repository reads exclude Contact before their limits. Keep this
      // defensive scheduler-only guard for stale carry-over metadata and
      // alternate repository implementations: an unsupported notification
      // must not consume either fresh or recovery selection capacity.
      const unsupportedBufferedContacts = candidates.flatMap((item) =>
        isUnsupportedContact(item) && item.recoveryBufferGeneration
          ? [{ key: item.key, generation: item.recoveryBufferGeneration }]
          : [],
      );
      if (unsupportedBufferedContacts.length > 0) {
        try {
          await callbackEvents.pruneRecoveryCandidates(
            unsupportedBufferedContacts,
            outboundPolicy.callbackNotBeforeMs != null
              ? new Date(outboundPolicy.callbackNotBeforeMs)
              : undefined,
          );
        } catch {
          // This only frees scheduler metadata. On failure, retain the
          // notification and its buffer entry rather than touching callback
          // state or blocking supported work.
          console.warn("[ProtractorCallbackQueue] recovery buffer prune unavailable");
        }
      }
      const schedulableCandidates = candidates.filter((item) => !isUnsupportedContact(item));
      const freshCandidates = schedulableCandidates.filter((item) => item.selectionLane !== "recovery");
      const recoveryCandidates = schedulableCandidates.filter((item) => item.selectionLane === "recovery");
      // Keep the oldest-first lane distinct through both fair selections. A
      // single reserved slot gives an expired/previously-attempted callback a
      // bounded path to durable admission while retaining forty-four of forty-
      // five slots for fresh work.
      const freshPreselection = selectFairCallbackBatch(
        freshCandidates,
        Math.min(freshCandidates.length, limit * 6),
      );
      const recoveryPreselection = selectFairCallbackBatch(
        recoveryCandidates,
        Math.min(recoveryCandidates.length, CALLBACK_RECOVERY_CANDIDATE_LIMIT),
      );
      const authorityFiltered = await callbackEvents.filterPendingCallbackCandidatesByAuthority(
        [...freshPreselection.selected, ...recoveryPreselection.selected],
        outboundPolicy.callbackNotBeforeMs != null
          ? new Date(outboundPolicy.callbackNotBeforeMs)
          : undefined,
      );
      // Authority is a read-only scheduling check. Buffered entries that are
      // no longer winners must not occupy the single recovery slot forever
      // (for example behind an exhausted terminal), but this never completes
      // or otherwise mutates their callback rows. A metadata CAS loss retains
      // the entry and is safe to retry on the next invocation.
      const authorityKeys = new Set(authorityFiltered.map((item) => item.key));
      const authorityReviewed = [
        ...freshPreselection.selected,
        ...freshPreselection.coalesced,
        ...recoveryPreselection.selected,
        ...recoveryPreselection.coalesced,
      ];
      const rejectedBufferGenerations = new Set<string>();
      const authorityRejectedBuffered = authorityReviewed.flatMap((item) => {
        if (!item.recoveryBufferGeneration || authorityKeys.has(item.key)) return [];
        const fingerprint = `${item.key}\u0000${item.recoveryBufferGeneration}`;
        if (rejectedBufferGenerations.has(fingerprint)) return [];
        rejectedBufferGenerations.add(fingerprint);
        return [{ key: item.key, generation: item.recoveryBufferGeneration }];
      });
      if (authorityRejectedBuffered.length > 0) {
        try {
          await callbackEvents.pruneRecoveryCandidates(
            authorityRejectedBuffered,
            outboundPolicy.callbackNotBeforeMs != null
              ? new Date(outboundPolicy.callbackNotBeforeMs)
              : undefined,
          );
        } catch {
          // Scheduler metadata is advisory; a pruning failure must retain the
          // candidate, not block fresh callback admission.
          console.warn("[ProtractorCallbackQueue] recovery buffer prune unavailable");
        }
      }
      const recoveredKeys = new Set(recoveryPreselection.selected.map((item) => item.key));
      const recoveryAuthority = authorityFiltered.filter((item) => recoveredKeys.has(item.key));
      const freshAuthority = authorityFiltered.filter((item) => !recoveredKeys.has(item.key));
      const recoverySelection = selectFairCallbackBatch(
        recoveryAuthority,
        Math.min(CALLBACK_RECOVERY_RESERVED_SLOTS, limit),
      );
      const freshSelection = selectFairCallbackBatch(
        freshAuthority,
        limit - recoverySelection.selected.length,
      );
      const selection = {
        selected: [...recoverySelection.selected, ...freshSelection.selected],
        coalesced: [...recoverySelection.coalesced, ...freshSelection.coalesced],
      };
      candidateCount = candidates.length;
      selectedCount = selection.selected.length;
      // This is only the in-memory duplicate collapse performed while
      // selecting the batch; it is not durable coalescing.
      selectionCollapsedCount =
        freshPreselection.coalesced.length +
        recoveryPreselection.coalesced.length +
        selection.coalesced.length;
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
                  // A transient ownership race must not let the oldest buffered
                  // candidate monopolize the only recovery slot. Keep it
                  // durable but rotate its exact generation behind its peers.
                  if (item.recoveryBufferGeneration) {
                    try {
                      await callbackEvents.rotateRecoveryCandidate(
                        item.key,
                        item.recoveryBufferGeneration,
                        outboundPolicy.callbackNotBeforeMs != null
                          ? new Date(outboundPolicy.callbackNotBeforeMs)
                          : undefined,
                      );
                    } catch {
                      // CAS loss/failure retains the entry, which is safer than
                      // dropping it; a later invocation can rotate it again.
                      console.warn("[ProtractorCallbackQueue] recovery buffer rotation unavailable");
                    }
                  }
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
            // Claim/admission itself is asynchronous. It may cross the
            // invocation deadline even though the pre-claim guard passed;
            // release the fence in finally, but never begin provider work.
            if (Date.now() >= deadlineMs) {
              exitReason = "deadline";
              timingOutcome = "skipped";
              break;
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
            // The durable attempt is the acknowledgement point. In particular,
            // a slow claim that crosses the deadline releases its fence above
            // without losing buffered work before provider admission.
            if (item.recoveryBufferGeneration) {
              try {
                await callbackEvents.acknowledgeRecoveryCandidate(
                  item.key,
                  item.recoveryBufferGeneration,
                  outboundPolicy.callbackNotBeforeMs != null
                    ? new Date(outboundPolicy.callbackNotBeforeMs)
                    : undefined,
                );
              } catch {
                console.warn("[ProtractorCallbackQueue] recovery buffer acknowledgement unavailable");
              }
            }
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