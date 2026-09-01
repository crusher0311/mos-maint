import {
  evaluateProtractorOutboundPolicy,
} from "../lib/integrations/protractor/outbound-policy.cjs";
import {
  __protractorClientTestHooks,
  createServiceItem,
  protractorFetch,
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
  connectionId: "test-connection",
  apiKey: "test-key",
  authentication: "test-auth",
  configured: true,
};

async function main() {
  const originalOutboundDisabled = process.env.PROTRACTOR_OUTBOUND_DISABLED;
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
  __protractorClientTestHooks.resolveProtractorConfig = async () => config;
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

  delete process.env.RENDER_INSTANCE_ID;
  delete process.env.PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS;
  __protractorClientTestHooks.enforceLocalPolicyWithMockTransport = false;
  if (originalOutboundDisabled === undefined) {
    delete process.env.PROTRACTOR_OUTBOUND_DISABLED;
  } else {
    process.env.PROTRACTOR_OUTBOUND_DISABLED = originalOutboundDisabled;
  }
  if (failures) throw new Error(`${failures} task 1248 checks failed`);
  console.log("\nAll task 1248 instance-policy checks passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});