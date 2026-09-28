import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import {
  __protractorClientTestHooks as hooks, testConnection, protractorFetch,
} from "../lib/integrations/protractor/client";

// Offline transport only; these hooks never load canonical stores or providers.
hooks.acquireDistributedRateLimitSlot = async () => ({ acquired: true, waitedMs: 0, currentCount: 0 });
hooks.acquireOutboundGate = async () => ({ allowed: true, probe: false });
hooks.recordResponse = async () => {};
hooks.trackApiRequest = async () => {};
hooks.getOperatorStop = async () => ({ active: false, physicalAdmissionInFlight: false, canaryHistory: [] });
let calls = 0;
let status = 200;
let options: any;
hooks.onFetchStart = (_endpoint, opts) => { options = opts; };
hooks.httpsRequest = async (_url, _method, _headers, _body, timeoutMs) => {
  calls++;
  assert.ok(timeoutMs! > 0 && timeoutMs! <= 5000, "physical request receives remaining deadline");
  return { statusCode: status, headers: {}, body: status === 200 ? '{"ItemCollection":[]}' : "offline failure" };
};
async function run() {
  for (const code of [200, 401, 403, 429, 500, 503]) {
    status = code;
    const before = calls;
    const result = await testConnection("offline-id", "offline-key", 42);
    assert.equal(calls, before + 1, "validation performs at most one attempt, including 429/5xx");
    assert.equal(options.priority, true);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.timeoutMs, 5000);
    assert.ok(options.deadlineAtMs <= Date.now() + 5000);
    assert.equal(result.ok, code === 200);
    if (code === 401 || code === 403) assert.equal(result.code, "PROTRACTOR_INVALID_CREDENTIALS");
    if (code >= 429) assert.equal(result.code, "PROTRACTOR_VALIDATION_UNAVAILABLE");
  }
  const config = { shopId: 42, configured: true, connectionId: "offline-id", apiKey: "offline-key", authentication: "offline" };
  const before = calls;
  const expired = await protractorFetch("/Location/", config, {}, 0, 42, {
    priority: true, maxRetries: 0, timeoutMs: 5000, deadlineAtMs: Date.now() - 1,
  });
  assert.equal(expired.ok, false);
  assert.equal(calls, before, "an expired queued validation cannot dispatch");
  hooks.acquireOutboundGate = async () => ({ allowed: false, probe: false, reason: "offline restriction" } as any);
  assert.equal((await testConnection("offline-id", "offline-key", 42)).code, "PROTRACTOR_VALIDATION_UNAVAILABLE");
  assert.equal(calls, before, "shared guard denial stays before transport");
  hooks.acquireOutboundGate = async () => {
    await new Promise(resolve => setTimeout(resolve, 5100));
    return { allowed: true, probe: false };
  };
  const started = Date.now();
  assert.equal((await testConnection("offline-id", "offline-key", 42)).code, "PROTRACTOR_VALIDATION_UNAVAILABLE");
  assert.ok(Date.now() - started < 5500, "validation response is deadline-bounded");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls, before, "late admission completion cannot dispatch discarded validation");
  console.log("Protractor credential validation bounded transport coverage passed");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
// Hooks deliberately remain installed until process exit.