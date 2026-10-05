import "./helpers/deny-network-egress";
import {
  evaluateProtractorOutboundPolicy,
} from "../lib/integrations/protractor/outbound-policy.cjs";
import {
  __protractorClientTestHooks,
  createServiceItem,
  protractorFetch,
  runWithProtractorCallbackTransport,
  soapAddServicePackage,
  type ProtractorConfig,
} from "../lib/integrations/protractor/client";
import { isPostAdmissionMatch } from "../lib/data/repositories/pg/protractor-callback-events";

let failures = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

const config: ProtractorConfig = {
  shopId: 1,
  connectionId: "test-connection",
  apiKey: "test-key",
  authentication: "test-auth",
  configured: true,
};

const ENV_KEYS = [
  "NODE_ENV",
  "REPLIT_DEV_DOMAIN",
  "PROTRACTOR_DEVELOPMENT_RELAY_APPROVED",
  "PROTRACTOR_OUTBOUND_DISABLED",
  "PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS",
  "PROTRACTOR_CALLBACK_CANARY_UNTIL",
  "PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE",
  "RENDER_INSTANCE_ID",
] as const;

async function main() {
  const originalEnvironment = new Map<string, string | undefined>(
    ENV_KEYS.map(key => [key, process.env[key]]),
  );
  const restoreEnvironment = () => {
    for (const key of ENV_KEYS) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else (process.env as Record<string, string | undefined>)[key] = value;
    }
  };
  process.once("exit", restoreEnvironment);
  const testEnv = process.env as Record<string, string | undefined>;
  // This suite owns the instance-policy fixtures. Do not let the hosting
  // preview identity silently turn ordinary-policy assertions into the
  // development relay gate; restore every selector before the process exits.
  testEnv.NODE_ENV = "test";
  delete testEnv.REPLIT_DEV_DOMAIN;
  delete testEnv.PROTRACTOR_DEVELOPMENT_RELAY_APPROVED;
  delete testEnv.PROTRACTOR_OUTBOUND_DISABLED;
  delete testEnv.PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS;
  delete testEnv.PROTRACTOR_CALLBACK_CANARY_UNTIL;
  delete testEnv.PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE;
  delete testEnv.RENDER_INSTANCE_ID;

  const base = { RENDER_INSTANCE_ID: "srv-a" };
  ok("empty deny policy allows", evaluateProtractorOutboundPolicy(base).allowed);
  ok(
    "Render identity is denied from JSON policy",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS: '["srv-a","srv-b"]',
    }).reason === "denied_instance",
  );
  ok(
    "CSV policy allows a different replica",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS: "srv-b,srv-c",
    }).allowed,
  );
  ok(
    "malformed policy fails closed",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS: '["srv-a",7]',
    }).reason === "malformed_policy",
  );
  ok(
    "configured policy without identity fails closed",
    evaluateProtractorOutboundPolicy({
      PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS: "srv-a",
    }).reason === "missing_identity",
  );
  ok(
    "configured Render policy never falls back to hostname",
    evaluateProtractorOutboundPolicy({
      HOSTNAME: "srv-a",
      PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS: "srv-a",
    }).reason === "missing_identity",
  );
  ok(
    "service stop has highest priority",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_OUTBOUND_DISABLED: "true",
      PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS: "[bad",
    }).reason === "service_disabled",
  );
  ok(
    "active callback canary is allowed but callback-only",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_CALLBACK_CANARY_UNTIL: "2026-09-09T17:30:00.000Z",
      PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE: "2026-09-09T16:50:00.000Z",
    }, Date.parse("2026-09-09T17:00:00.000Z")).callbackOnly === true,
  );
  ok(
    "expired callback canary fails closed",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_CALLBACK_CANARY_UNTIL: "2026-09-09T17:00:00.000Z",
      PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE: "2026-09-09T16:50:00.000Z",
    }, Date.parse("2026-09-09T17:00:00.000Z")).reason === "callback_canary_expired",
  );
  ok(
    "malformed callback canary fails closed",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_CALLBACK_CANARY_UNTIL: "not-a-time",
    }).reason === "malformed_callback_canary",
  );
  for (const malformed of [
    "",
    "   ",
    "2026-02-30T00:00:00.000Z",
    "2027-02-29T00:00:00.000Z",
    "2026-09-09",
    "09/09/2026 18:00:00",
    " 2026-09-09T18:00:00.000Z ",
  ]) {
    ok(
      `non-canonical callback canary fails closed: ${JSON.stringify(malformed)}`,
      evaluateProtractorOutboundPolicy({
        ...base,
        PROTRACTOR_CALLBACK_CANARY_UNTIL: malformed,
      }).reason === "malformed_callback_canary",
    );
  }
  ok(
    "service stop wins over an otherwise active callback canary",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_OUTBOUND_DISABLED: "true",
      PROTRACTOR_CALLBACK_CANARY_UNTIL: "2026-09-09T18:00:00.000Z",
    }, Date.parse("2026-09-09T17:00:00.000Z")).reason === "service_disabled",
  );
  ok(
    "callback canary without a replay floor fails closed",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_CALLBACK_CANARY_UNTIL: "2026-09-09T18:00:00.000Z",
    }, Date.parse("2026-09-09T17:00:00.000Z")).reason === "missing_callback_replay_floor",
  );
  ok(
    "standalone callback replay floor allows normal transport with a durable queue boundary",
    (() => {
      const policy = evaluateProtractorOutboundPolicy({
        ...base,
        PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE: "2026-09-09T16:00:00.000Z",
      });
      return policy.allowed === true &&
        policy.callbackOnly === false &&
        policy.callbackNotBeforeMs === Date.parse("2026-09-09T16:00:00.000Z");
    })(),
  );
  ok(
    "malformed standalone callback replay floor fails closed",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE: "not-a-time",
    }).reason === "malformed_callback_replay_floor",
  );
  ok(
    "callback replay floor at or after cutoff fails closed",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_CALLBACK_CANARY_UNTIL: "2026-09-09T18:00:00.000Z",
      PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE: "2026-09-09T18:00:00.000Z",
    }, Date.parse("2026-09-09T17:00:00.000Z")).reason === "malformed_callback_replay_floor",
  );
  ok(
    "stale callback replay floor fails closed",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_CALLBACK_CANARY_UNTIL: "2026-09-09T17:20:00.000Z",
      PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE: "2026-09-09T16:29:59.999Z",
    }, Date.parse("2026-09-09T17:00:00.000Z")).reason === "stale_callback_replay_floor",
  );
  ok(
    "future callback replay floor fails closed",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_CALLBACK_CANARY_UNTIL: "2026-09-09T17:20:00.000Z",
      PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE: "2026-09-09T17:00:00.001Z",
    }, Date.parse("2026-09-09T17:00:00.000Z")).reason === "future_callback_replay_floor",
  );
  ok(
    "overlong callback canary fails closed",
    evaluateProtractorOutboundPolicy({
      ...base,
      PROTRACTOR_CALLBACK_CANARY_UNTIL: "2026-09-09T17:45:00.001Z",
      PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE: "2026-09-09T16:50:00.000Z",
    }, Date.parse("2026-09-09T17:00:00.000Z")).reason === "callback_canary_too_long",
  );
  ok(
    "deferred POST retains the POST admission identity",
    isPostAdmissionMatch(
      { method: "POST", shopId: 12, workOrderId: "wo-12", status: "open" },
      { method: "POST", shopId: 12, objectType: "WorkOrder", objectId: "wo-12", operation: "OPEN" },
    ),
  );

  let requests = 0;
  let breakerClaims = 0;
  let rateClaims = 0;
  __protractorClientTestHooks.httpsRequest = async () => {
    requests++;
    return { statusCode: 200, body: "{}" };
  };
  __protractorClientTestHooks.acquireOutboundGate = async () => {
    breakerClaims++;
    return { allowed: true, probe: false };
  };
  __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => {
    rateClaims++;
    return { acquired: true, waitedMs: 0, currentCount: 0 };
  };
  __protractorClientTestHooks.recordResponse = async () => {};
  __protractorClientTestHooks.resolveProtractorConfig = async () => config;
  __protractorClientTestHooks.getOperatorStop = async () => ({
    active: false,
    canary: undefined,
  } as any);
  __protractorClientTestHooks.acquireCallbackTransportLease = async () => "callback-test";
  __protractorClientTestHooks.releaseCallbackTransportLease = async () => {};
  __protractorClientTestHooks.enforceLocalPolicyWithMockTransport = true;
  process.env.RENDER_INSTANCE_ID = "srv-denied";
  process.env.PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS = "srv-denied";
  await Promise.all([
    protractorFetch("/Invoice/denied", config),
    createServiceItem(1, { ownerId: "owner" }),
    soapAddServicePackage(1, "wo", { ID: "wo" }),
  ]);
  ok("denied replica makes zero REST/SOAP requests", requests === 0);
  ok("denial precedes distributed breaker and rate budget", breakerClaims === 0 && rateClaims === 0);

  process.env.RENDER_INSTANCE_ID = "srv-allowed";
  delete process.env.PROTRACTOR_OUTBOUND_DISABLED;
  await protractorFetch("/Invoice/allowed", config, {}, 0, 1, { maxRetries: 0 });
  ok("allowed replica reaches Protractor transport", requests === 1);
  ok(
    "policy changes are re-evaluated on a later transport attempt",
    evaluateProtractorOutboundPolicy({
      RENDER_INSTANCE_ID: "srv-allowed",
      PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS: "srv-allowed",
    }).reason === "denied_instance",
  );

  const beforeCanaryRequests = requests;
  const beforeCanaryBreakerClaims = breakerClaims;
  process.env.PROTRACTOR_CALLBACK_CANARY_UNTIL = new Date(Date.now() + 60_000).toISOString();
  process.env.PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE = new Date(Date.now() - 60_000).toISOString();
  delete process.env.PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS;
  await Promise.all([
    protractorFetch("/Invoice/non-callback-canary", config, {}, 0, 1, { maxRetries: 0 }),
    soapAddServicePackage(1, "wo", { ID: "wo" }),
  ]);
  ok(
    "callback canary blocks non-callback REST/SOAP before shared gates",
    requests === beforeCanaryRequests && breakerClaims === beforeCanaryBreakerClaims,
  );
  await runWithProtractorCallbackTransport(Date.now() + 10_000, async () => {
    await Promise.all([
      protractorFetch("/Invoice/callback-canary", config, {}, 0, 1, { maxRetries: 0 }),
      soapAddServicePackage(1, "wo", { ID: "wo" }),
    ]);
  });
  ok("callback canary admits callback-scoped REST/SOAP", requests === beforeCanaryRequests + 2);

  let fakeNow = Date.parse("2026-09-09T17:00:00.000Z");
  __protractorClientTestHooks.now = () => fakeNow;
  __protractorClientTestHooks.sleep = async (ms) => { fakeNow += ms; };
  __protractorClientTestHooks.httpsRequest = async () => {
    requests++;
    return { statusCode: 500, body: "transient" };
  };

  process.env.PROTRACTOR_CALLBACK_CANARY_UNTIL = new Date(fakeNow + 1_000).toISOString();
  process.env.PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE = new Date(fakeNow - 1_000).toISOString();
  const beforeExpiringRest = {
    requests,
    breakerClaims,
    rateClaims,
  };
  await runWithProtractorCallbackTransport(Date.now() + 10_000, () =>
    protractorFetch("/Invoice/expiring-canary", config, {}, 0, 1, { maxRetries: 1 }),
  );
  ok(
    "REST retry rechecks canary expiry before a second physical request",
    requests === beforeExpiringRest.requests + 1 &&
      breakerClaims === beforeExpiringRest.breakerClaims + 1 &&
      rateClaims === beforeExpiringRest.rateClaims + 1,
  );

  process.env.PROTRACTOR_CALLBACK_CANARY_UNTIL = new Date(fakeNow + 1_000).toISOString();
  process.env.PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE = new Date(fakeNow - 1_000).toISOString();
  const beforeExpiringSoap = {
    requests,
    breakerClaims,
    rateClaims,
  };
  await runWithProtractorCallbackTransport(Date.now() + 10_000, () =>
    soapAddServicePackage(1, "wo", { ID: "wo" }),
  );
  ok(
    "SOAP retry rechecks canary expiry before a second physical request",
    requests === beforeExpiringSoap.requests + 1 &&
      breakerClaims === beforeExpiringSoap.breakerClaims + 1 &&
      rateClaims === beforeExpiringSoap.rateClaims + 1,
  );

  delete process.env.RENDER_INSTANCE_ID;
  delete process.env.PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS;
  delete process.env.PROTRACTOR_CALLBACK_CANARY_UNTIL;
  delete process.env.PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE;
  __protractorClientTestHooks.now = () => Date.now();
  __protractorClientTestHooks.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  __protractorClientTestHooks.enforceLocalPolicyWithMockTransport = false;
  restoreEnvironment();
  process.removeListener("exit", restoreEnvironment);
  if (failures) throw new Error(`${failures} task 1248 checks failed`);
  console.log("\nAll task 1248 instance-policy checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});