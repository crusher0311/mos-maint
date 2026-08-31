import {
  __protractorClientTestHooks,
  createServiceItem,
  parseProtractorRetryAfter,
  protractorFetch,
  soapAddServicePackage,
  type ProtractorConfig,
} from "../lib/integrations/protractor/client";
import {
  __protractorCircuitBreakerTestHooks,
  acquireProtractorOutboundGate,
  PROTRACTOR_TRANSPORT_FAILURE_STATUS,
} from "../lib/data/repositories/protractor-circuit-breaker";
import { readFileSync } from "node:fs";

let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const config: ProtractorConfig = {
  connectionId: "connection-a",
  apiKey: "key",
  authentication: "auth",
  configured: true,
};

async function main() {
  __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
    acquired: true, waitedMs: 0, currentCount: 0,
  });
  __protractorClientTestHooks.trackApiRequest = async () => {};
  __protractorClientTestHooks.resolveProtractorConfig = async () => config;
  __protractorClientTestHooks.random = () => 0;

  console.log("Scenario 1: kill switch precedes every gate and transport");
  {
    let gates = 0;
    let requests = 0;
    process.env.PROTRACTOR_OUTBOUND_DISABLED = "true";
    __protractorClientTestHooks.acquireOutboundGate = async () => {
      gates++;
      return { allowed: true, probe: false };
    };
    __protractorClientTestHooks.httpsRequest = async () => {
      requests++;
      return { statusCode: 200, body: "{}" };
    };
    await Promise.all([
      protractorFetch("/Invoice/kill", config),
      createServiceItem(1, { ownerId: "owner" }),
      soapAddServicePackage(1, "wo", { ID: "wo" }),
    ]);
    ok("kill switch prevents REST and both SOAP transports", requests === 0, `requests=${requests}`);
    ok("kill switch is evaluated before distributed gate", gates === 0, `gates=${gates}`);
    delete process.env.PROTRACTOR_OUTBOUND_DISABLED;
  }

  console.log("Scenario 1b: manual Protractor scripts use the guarded shared transport");
  for (const file of [
    "scripts/protractor-auto-backfill.ts",
    "scripts/protractor-history-backfill.ts",
    "scripts/protractor-shop25-backfill.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    ok(
      `${file} has no direct transport bypass`,
      /import\s+\{\s*protractorFetch\s*\}\s+from\s+"..\/lib\/integrations\/protractor\/client"/.test(source) &&
        !/\bfetch\s*\(|https\.request\s*\(/.test(source),
    );
  }

  console.log("Scenario 2: correlated auth storm is cut off client-wide");
  {
    const blocked = new Set<string>();
    const providerFailures = new Set<string>();
    let providerOpen = false;
    let requests = 0;
    __protractorClientTestHooks.acquireOutboundGate = async (connectionId) =>
      providerOpen || blocked.has(connectionId)
        ? { allowed: false, reason: "test circuit open", retryAfterMs: 300_000 }
        : { allowed: true, probe: false };
    __protractorClientTestHooks.recordResponse = async (connectionId, status) => {
      if (status === 401 || status === 403) {
        blocked.add(connectionId);
        providerFailures.add(connectionId);
        providerOpen = providerFailures.size >= 3;
      }
    };
    __protractorClientTestHooks.httpsRequest = async () => {
      requests++;
      return { statusCode: 401, body: "unauthorized" };
    };
    for (const id of ["a", "b", "c"]) {
      await protractorFetch("/Invoice/auth", { ...config, connectionId: id }, {}, 0, 1, { maxRetries: 0 });
    }
    const before = requests;
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        protractorFetch("/Invoice/storm", { ...config, connectionId: `fresh-${i}` }, {}, 0, 1, { maxRetries: 0 }),
      ),
    );
    ok("three distinct credential failures correlate provider-wide", providerOpen);
    ok("provider-wide storm makes zero further network calls", requests === before, `requests=${requests}`);
    ok("all storm calls fail closed", results.every((result) => !result.ok && /circuit/i.test(result.error || "")));
  }

  console.log("Scenario 2b: concurrent SOAP calls share the distributed request ceiling");
  {
    let budgetClaims = 0;
    let requests = 0;
    const ceiling = 2;
    __protractorClientTestHooks.acquireOutboundGate = async () => ({ allowed: true, probe: false });
    __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => {
      budgetClaims++;
      return budgetClaims <= ceiling
        ? { acquired: true, waitedMs: 0, currentCount: budgetClaims }
        : { acquired: false, waitedMs: 0, currentCount: budgetClaims };
    };
    __protractorClientTestHooks.recordResponse = async () => {};
    __protractorClientTestHooks.sleep = async () => {};
    __protractorClientTestHooks.httpsRequest = async () => {
      requests++;
      return { statusCode: 503, body: "down" };
    };
    await Promise.all([
      ...Array.from({ length: 4 }, () => createServiceItem(1, { ownerId: "owner" })),
      ...Array.from({ length: 4 }, () => soapAddServicePackage(1, "wo", { ID: "wo" })),
    ]);
    ok(
      "SOAP initial calls and retries cannot exceed the distributed ceiling before breaker feedback",
      requests === ceiling,
      `requests=${requests}`,
    );
    ok(
      "every SOAP attempt claims the shared provider budget",
      budgetClaims === 10,
      `claims=${budgetClaims}`,
    );
    __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
      acquired: true, waitedMs: 0, currentCount: 0,
    });
  }

  console.log("Scenario 3: cooldown admits one controlled probe");
  {
    let claimed = false;
    let probeRequests = 0;
    __protractorClientTestHooks.acquireOutboundGate = async () => {
      if (!claimed) {
        claimed = true;
        return { allowed: true, probe: true };
      }
      return { allowed: false, reason: "probe in flight", retryAfterMs: 30_000 };
    };
    __protractorClientTestHooks.recordResponse = async () => {};
    __protractorClientTestHooks.httpsRequest = async () => {
      probeRequests++;
      return { statusCode: 200, body: "{}" };
    };
    const results = await Promise.all(
      Array.from({ length: 25 }, () => protractorFetch("/Invoice/probe", config, {}, 0, 1, { maxRetries: 0 })),
    );
    ok("exactly one network probe escapes a recovery storm", probeRequests === 1, `requests=${probeRequests}`);
    ok("exactly one caller succeeds", results.filter((result) => result.ok).length === 1);
  }

  console.log("Scenario 4: Retry-After and transient backoff are deterministic and bounded");
  {
    const sleeps: number[] = [];
    let attempts = 0;
    __protractorClientTestHooks.acquireOutboundGate = async () => ({ allowed: true, probe: false });
    __protractorClientTestHooks.recordResponse = async () => {};
    __protractorClientTestHooks.sleep = async (ms) => { sleeps.push(ms); };
    __protractorClientTestHooks.retryBaseDelayMs = 1_000;
    __protractorClientTestHooks.httpsRequest = async () => {
      attempts++;
      return attempts === 1
        ? { statusCode: 429, body: "slow down", headers: { "retry-after": "120" } }
        : { statusCode: 503, body: "down" };
    };
    await protractorFetch("/Invoice/retry-after", config, {}, 0, 1, { maxRetries: 2 });
    ok("oversized Retry-After is capped at 60 seconds", sleeps[0] === 60_000, JSON.stringify(sleeps));
    ok("5xx exponential retry remains capped at 10 seconds", sleeps[1] === 4_000, JSON.stringify(sleeps));
    ok("HTTP-date Retry-After parser is bounded", parseProtractorRetryAfter("Wed, 01 Jan 2100 00:00:00 GMT", 0) === 60_000);
  }

  console.log("Scenario 5: breaker telemetry cannot alter completed responses");
  {
    let requests = 0;
    const recorded: number[] = [];
    __protractorClientTestHooks.acquireOutboundGate = async () => ({ allowed: true, probe: false });
    __protractorClientTestHooks.recordResponse = async (_connectionId, status) => {
      recorded.push(status);
      throw new Error("mongo unavailable");
    };
    __protractorClientTestHooks.httpsRequest = async () => {
      requests++;
      return { statusCode: 200, body: JSON.stringify({ completed: true }) };
    };
    const response = await protractorFetch<{ completed: boolean }>("/Invoice/telemetry", config, {}, 0, 1, { maxRetries: 2 });
    ok("failed breaker telemetry preserves a completed upstream response", response.ok && response.data?.completed === true);
    ok("failed telemetry does not retry a completed request", requests === 1, `requests=${requests}`);

    __protractorClientTestHooks.recordResponse = async (_connectionId, status) => {
      recorded.push(status);
    };
    __protractorClientTestHooks.httpsRequest = async () => {
      throw new Error("socket reset");
    };
    const failedResponse = await protractorFetch("/Invoice/transport", config, {}, 0, 1, { maxRetries: 0 });
    ok("transport exception records synthetic transient signal", recorded.includes(PROTRACTOR_TRANSPORT_FAILURE_STATUS));
    ok("transport exception remains a transport failure", !failedResponse.ok && /socket reset/.test(failedResponse.error || ""));
  }

  console.log("Scenario 6: a denied provider scope rolls back a connection probe");
  {
    const released: string[] = [];
    __protractorCircuitBreakerTestHooks.claimScope = async (key) =>
      key.startsWith("connection:")
        ? { allowed: true, probe: true }
        : { allowed: false, reason: "provider open", retryAfterMs: 1_000 };
    __protractorCircuitBreakerTestHooks.releaseClaimedProbe = async (key) => { released.push(key); };
    const decision = await acquireProtractorOutboundGate("connection-for-rollback");
    ok("provider denial remains fail-closed", !decision.allowed);
    ok("connection probe is explicitly rolled back", released.length === 1 && released[0].startsWith("connection:"));
  }

  if (failed) throw new Error(`${failed} circuit-breaker check(s) failed`);
  console.log("\nAll task 1244 Protractor circuit-breaker checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});