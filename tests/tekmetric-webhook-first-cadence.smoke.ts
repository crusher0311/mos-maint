/**
 * Task #1089 — webhook-first Tekmetric sync: cadence selection.
 *
 * Run: `npx tsx tests/tekmetric-webhook-first-cadence.smoke.ts`
 *
 * Covers the pure coverage-classification + poll-cadence functions:
 *   - covered shops skip the fast poll until the safety-net interval elapses
 *   - uncovered shops (auto-subscribe off / no subscription / stale webhook /
 *     no events yet) always keep the fast poll
 *   - the kill switch forces everyone back to the fast poll
 */

import {
  classifyWebhookCoverage,
  selectPollCadence,
  getSafetyNetPollMs,
  getWebhookLivenessMs,
} from "../lib/integrations/tekmetric/webhook-coverage";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.parse("2026-08-11T12:00:00Z");
const MIN = 60_000;

console.log("tekmetric webhook-first cadence smoke");

// ---- classifyWebhookCoverage ----
{
  const base = {
    autoSubscribeEnabled: true,
    subscriptionOk: true,
    lastWebhookEventAt: new Date(NOW - 5 * MIN),
    now: NOW,
  };
  ok("covered when sub ok + recent event", classifyWebhookCoverage(base).covered === true);

  const off = classifyWebhookCoverage({ ...base, autoSubscribeEnabled: false });
  ok("auto-subscribe off → uncovered", !off.covered && off.reason === "auto_subscribe_off");

  const noSub = classifyWebhookCoverage({ ...base, subscriptionOk: false });
  ok("no healthy subscription → uncovered", !noSub.covered && noSub.reason === "no_healthy_subscription");

  const never = classifyWebhookCoverage({ ...base, lastWebhookEventAt: null });
  ok("no events yet → uncovered", !never.covered && never.reason === "no_events_yet");

  const stale = classifyWebhookCoverage({
    ...base,
    lastWebhookEventAt: new Date(NOW - 25 * 60 * MIN), // > 24h default liveness
  });
  ok("webhook-stale shop → uncovered", !stale.covered && stale.reason === "webhook_stale");

  const justInside = classifyWebhookCoverage({
    ...base,
    lastWebhookEventAt: new Date(NOW - 2 * 60 * MIN),
    livenessMs: 3 * 60 * MIN,
  });
  ok("event within explicit liveness window → covered", justInside.covered === true);

  const stringDate = classifyWebhookCoverage({
    ...base,
    lastWebhookEventAt: new Date(NOW - 5 * MIN).toISOString(),
  });
  ok("string timestamps accepted", stringDate.covered === true);
}

// ---- selectPollCadence ----
{
  const covered = { covered: true as const, reason: "covered" as const };
  const uncovered = { covered: false as const, reason: "webhook_stale" as const };

  // Uncovered → always fast poll.
  const fast = selectPollCadence({
    coverage: uncovered,
    lastSyncCursor: new Date(NOW - 1 * MIN),
    now: NOW,
    safetyNetMs: 20 * MIN,
    webhookFirstDisabled: false,
  });
  ok("uncovered shop keeps fast poll", fast.poll === true && fast.cadence === "fast");

  // Covered, cursor fresh → skip this tick with a skipReason.
  const skip = selectPollCadence({
    coverage: covered,
    lastSyncCursor: new Date(NOW - 5 * MIN),
    now: NOW,
    safetyNetMs: 20 * MIN,
    webhookFirstDisabled: false,
  });
  ok("covered + recent sync → skipped", skip.poll === false && skip.cadence === "safety-net");
  ok(
    "skip reason starts with webhook_covered (log/count contract)",
    !!skip.skipReason && skip.skipReason.startsWith("webhook_covered"),
    skip.skipReason,
  );

  // Covered, safety-net interval elapsed → poll.
  const due = selectPollCadence({
    coverage: covered,
    lastSyncCursor: new Date(NOW - 21 * MIN),
    now: NOW,
    safetyNetMs: 20 * MIN,
    webhookFirstDisabled: false,
  });
  ok("covered + interval elapsed → safety-net poll fires", due.poll === true && due.cadence === "safety-net");

  // Covered, exactly at the boundary → poll (>=).
  const boundary = selectPollCadence({
    coverage: covered,
    lastSyncCursor: new Date(NOW - 20 * MIN),
    now: NOW,
    safetyNetMs: 20 * MIN,
    webhookFirstDisabled: false,
  });
  ok("boundary (elapsed == interval) polls", boundary.poll === true);

  // Covered but no cursor at all → poll immediately.
  const noCursor = selectPollCadence({
    coverage: covered,
    lastSyncCursor: null,
    now: NOW,
    safetyNetMs: 20 * MIN,
    webhookFirstDisabled: false,
  });
  ok("covered + never synced → polls immediately", noCursor.poll === true);

  // Kill switch overrides coverage.
  const killed = selectPollCadence({
    coverage: covered,
    lastSyncCursor: new Date(NOW - 1 * MIN),
    now: NOW,
    safetyNetMs: 20 * MIN,
    webhookFirstDisabled: true,
  });
  ok("kill switch forces fast poll", killed.poll === true && killed.cadence === "fast");
}

// ---- env-tunable knobs ----
{
  delete process.env.TEKMETRIC_WEBHOOK_SAFETY_NET_POLL_MS;
  ok("default safety-net interval is 20 min", getSafetyNetPollMs() === 20 * MIN);
  process.env.TEKMETRIC_WEBHOOK_SAFETY_NET_POLL_MS = String(30 * MIN);
  ok("safety-net interval env-tunable", getSafetyNetPollMs() === 30 * MIN);
  process.env.TEKMETRIC_WEBHOOK_SAFETY_NET_POLL_MS = "not-a-number";
  ok("bad env value falls back to default", getSafetyNetPollMs() === 20 * MIN);
  delete process.env.TEKMETRIC_WEBHOOK_SAFETY_NET_POLL_MS;

  delete process.env.TEKMETRIC_WEBHOOK_LIVENESS_MS;
  ok("default liveness window is 24h", getWebhookLivenessMs() === 24 * 60 * MIN);
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll tekmetric webhook-first cadence assertions passed.");
