/**
 * Offline regression coverage for bounded callback winner selection.
 *
 * Run:
 * NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs' \
 * PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
 * npx tsx tests/protractor-callback-selection.smoke.ts
 */
import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import {
  replayableCallbackWindowWinners,
  type CallbackSelectionEvent,
} from "../lib/integrations/protractor/callback-selection";

const T = new Date("2026-08-31T00:00:00.000Z");
const at = (seconds: number) => new Date(T.getTime() + seconds * 1_000);

function event(
  key: string,
  shopId: number,
  objectId: string,
  operation: string,
  receivedAt: Date,
  replayEligible: boolean,
  winnerTieBreaker: string | number,
  method: "GET" | "POST" = "GET",
): CallbackSelectionEvent & { attempts: number; method: "GET" | "POST" } {
  return {
    key,
    method,
    shopId,
    objectType: "WorkOrder",
    objectId,
    operation,
    receivedAt,
    replayEligible,
    winnerTieBreaker,
    attempts: replayEligible ? 2 : 3,
  };
}

function keys(items: CallbackSelectionEvent[]): string[] {
  return items.map((item) => item.key);
}

// An exhausted newer non-terminal event is still the durable newest winner.
// Do not replay its older sibling just because it has retry budget.
{
  const exhausted = event("exhausted-new", 1, "same", "Update", at(2), false, 2);
  const older = event("older-retryable", 1, "same", "Update", at(1), true, 1);
  const result = replayableCallbackWindowWinners([older, exhausted]);
  assert.deepEqual(keys(result.winners), []);
  assert.deepEqual(keys(result.coalesced), ["older-retryable"]);
  assert.equal(exhausted.attempts, 3, "selection does not refund/retry exhausted notifications");
}

// Terminal precedence is independent of time and method. An exhausted POST
// close therefore still blocks a newer GET update for the same work order.
{
  const terminal = {
    ...event("exhausted-close", 42, "same", "Update", at(1), false, 1, "POST"),
    status: "CLOSED",
  };
  const newerUpdate = event("newer-get-update", "42" as unknown as number, "same", "Update", at(3), true, 2);
  const result = replayableCallbackWindowWinners([newerUpdate, terminal]);
  assert.deepEqual(keys(result.winners), []);
  assert.deepEqual(keys(result.coalesced), ["newer-get-update"]);
}

// An exhausted old *non-terminal* row must not suppress an actual newer
// update. This distinguishes the correction from blindly treating all
// exhausted history as terminal.
{
  const exhaustedOld = event("exhausted-old", 2, "same", "Update", at(1), false, 1);
  const newer = event("genuinely-new", 2, "same", "Update", at(2), true, 2);
  const result = replayableCallbackWindowWinners([exhaustedOld, newer]);
  assert.deepEqual(keys(result.winners), ["genuinely-new"]);
}

// Store-local tie breakers reproduce claim's final _id/id ordering instead
// of depending on array/query arrival order.
{
  const lower = event("lower-id", 3, "same", "Update", at(1), true, 10);
  const higherExhausted = event("higher-id-exhausted", 3, "same", "Update", at(1), false, 11);
  assert.deepEqual(
    keys(replayableCallbackWindowWinners([higherExhausted, lower]).winners),
    [],
    "higher equal-time exhausted winner blocks lower retryable row",
  );
  const higherRetryable = event("higher-id-retryable", 3, "same", "Update", at(1), true, 12);
  assert.deepEqual(
    keys(replayableCallbackWindowWinners([higherExhausted, higherRetryable]).winners),
    ["higher-id-retryable"],
    "higher equal-time retryable winner is selected",
  );
}

// Activation floors deliberately isolate a new generation from held history.
{
  const oldTerminal = event("old-terminal", 4, "same", "DELETE", at(1), false, 1);
  const activated = event("activated-update", 4, "same", "Update", at(2), true, 2);
  assert.deepEqual(
    keys(replayableCallbackWindowWinners([oldTerminal, activated], at(2)).winners),
    ["activated-update"],
  );
}

// Mongo ranks from the raw persisted operation/status before POST operation
// normalization. A supplied raw rank must therefore override trim-based
// helper inference for whitespace-bearing legacy values.
{
  const rawWhitespace = {
    ...event("raw-whitespace", 13, "same", "CLOSED", at(7), false, 7, "POST"),
    terminalRank: 0 as const,
  };
  const newerUpdate = {
    ...event("raw-newer", 13, "same", "Update", at(8), true, 8),
    terminalRank: 0 as const,
  };
  assert.deepEqual(
    keys(replayableCallbackWindowWinners([rawWhitespace, newerUpdate]).winners),
    ["raw-newer"],
    "raw terminal rank takes precedence over normalized operation text",
  );
}

// Blocked identities disappear before fair selection, leaving unrelated shops
// able to fill useful slots from the fixed candidate window.
{
  const blocked = event("blocked", 10, "blocked-object", "VOID", at(3), false, 3);
  const blockedSibling = event("blocked-sibling", 10, "blocked-object", "Update", at(4), true, 4);
  const shopA = event("shop-a-useful", 11, "a", "Update", at(5), true, 5);
  const shopB = event("shop-b-useful", 12, "b", "Update", at(6), true, 6);
  assert.deepEqual(
    keys(replayableCallbackWindowWinners([blocked, blockedSibling, shopA, shopB]).winners).sort(),
    ["shop-a-useful", "shop-b-useful"],
  );
}

console.log("protractor callback selection: all checks passed");