/**
 * Offline coverage for the live-monitor endpoint and reusable panel contract.
 * It replaces auth and the monitor repository before importing the route, and
 * blocks network egress. No database, provider, worker, or browser is started.
 */
import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";

const originalLoad = (Module as any)._load;
let authorized = true;
let calls = 0;
const report = {
  generatedAt: "2026-08-31T12:00:00.000Z",
  scope: { environment: "production", apiUsageCanonical: "mongo", callbackCanonical: "mongo", note: "bounded" },
  relay: { status: "sampled", sampleLimit: 50, sampled: 1, newestAt: "2026-08-31T12:00:00.000Z", durationScope: "client_attempt_including_local_admission_wait", latencySampled: 1, averageLatencyMs: 20, p95LatencyMs: 20, outcomes: { success: 1 }, note: "bounded" },
  callbacks: { status: "partial", sampleLimit: 400, sampled: 1, activationCohortStatus: "not_live", liveActivation: null, heldBacklog: { pendingSampled: 1, actionableSampled: 1, attemptsAtLeast3Sampled: 0, oldestActionableAgeMs: 10 }, retainedContactsSampled: 0, lastProgressAt: null, outcomes: { status: "sampled", sampleLimit: 200, sampled: 1, liveActivation: null, heldBacklog: { applied_indexed: 1 }, note: "bounded" }, note: "bounded" },
  breaker: { status: "sampled", state: "closed", openUntil: null, probeUntil: null, updatedAt: null, alerting: { transitionWiring: "present", deliveryStatus: "not-observable", note: "delivery unavailable" } },
};

(Module as any)._load = function(request: string, parent: any, isMain: boolean) {
  if (request === "@/lib/auth" || request.endsWith("/lib/auth")) {
    return { requirePlatformAdmin: async () => {
      if (!authorized) {
        const error: any = new Error("redirect");
        error.digest = "NEXT_REDIRECT;replace;/admin-login";
        throw error;
      }
      return { isPlatformAdmin: true };
    }};
  }
  if (request === "@/lib/data/repositories/protractor-live-monitor" || request.endsWith("/lib/data/repositories/protractor-live-monitor")) {
    return { getProtractorLiveMonitor: async () => { calls += 1; return report; } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  process.env.RENDER_SERVICE_ID = "srv-d55jaqkhg0os73a5dd8g";
  const { GET } = await import("../app/api/platform-admin/protractor-live-monitor/route");
  authorized = false;
  assert.equal((await GET()).status, 401);
  assert.equal(calls, 0, "repository is untouched on auth denial");
  authorized = true;
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), report);
  assert.equal(calls, 1);
  process.env.RENDER_SERVICE_ID = "preview-service";
  assert.equal((await GET()).status, 403, "read source is production-service scoped");
  assert.equal(calls, 1, "repository is untouched outside production scope");

  const route = readFileSync("app/api/platform-admin/protractor-live-monitor/route.ts", "utf8");
  const panel = readFileSync("components/platform-admin/ProtractorLiveMonitor.tsx", "utf8");
  const repository = readFileSync("lib/data/repositories/protractor-live-monitor.ts", "utf8");
  assert.match(route, /requirePlatformAdmin/);
  assert.match(route, /PRODUCTION_SERVICE_ID/);
  assert.match(panel, /visibilitychange/);
  assert.match(panel, /method: "GET"/);
  assert.doesNotMatch(panel, /method: "POST"|method: "PUT"|method: "PATCH"|method: "DELETE"/);
  assert.match(repository, /hint: "provider_1_timestamp_-1"/);
  assert.match(repository, /hint: "method_1_processed_1_priority_1_receivedAt_1"/);
  assert.match(repository, /hint: "method_1_processedAt_-1"/);
  assert.match(repository, /maxTimeMS: QUERY_MAX_MS/);
  assert.doesNotMatch(repository, /createIndex|insertOne|updateOne|deleteOne/);
  console.log("✓ live Protractor monitor endpoint/panel offline contract passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  (Module as any)._load = originalLoad;
});