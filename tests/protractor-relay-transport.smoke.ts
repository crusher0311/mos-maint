import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyProtractorEndpoint,
  classifyProtractorRequest,
  createProtractorRelayRequest,
  readProtractorRelayErrorCode,
  readProtractorRelayConfig,
  RelayTransportError,
  shouldUseProtractorRelay,
} from "../lib/integrations/protractor/relay-transport";

const secret = "s".repeat(32);
const relayUrl = "https://protractor-relay.mos.tools/relay";

const instrumentationSource = readFileSync(
  new URL("../src/instrumentation.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(instrumentationSource, /^import .*relay-/m);
assert.doesNotMatch(instrumentationSource, /relay-transport/);
assert.ok(
  instrumentationSource.indexOf('NEXT_RUNTIME !== "nodejs"') <
    instrumentationSource.indexOf("@/lib/integrations/protractor/relay-config"),
  "relay preflight import must stay behind the Node runtime boundary",
);

function relayConfig() {
  const config = readProtractorRelayConfig({
    PROTRACTOR_RELAY_MODE: "relay",
    PROTRACTOR_RELAY_URL: relayUrl,
    PROTRACTOR_RELAY_HMAC_SECRET: secret,
  });
  assert.equal(config.mode, "relay");
  return config;
}

// Direct remains the default and does not require or inspect relay-only values.
assert.deepEqual(readProtractorRelayConfig({}), { mode: "direct" });
assert.deepEqual(readProtractorRelayConfig({
  PROTRACTOR_RELAY_MODE: "direct",
  PROTRACTOR_RELAY_URL: "not a URL",
  PROTRACTOR_RELAY_HMAC_SECRET: "short",
}), { mode: "direct" });
assert.throws(
  () => readProtractorRelayConfig({ PROTRACTOR_RELAY_REQUIRED: "true" }),
  /must be relay/,
);
assert.throws(
  () => readProtractorRelayConfig({
    PROTRACTOR_RELAY_REQUIRED: "true",
    PROTRACTOR_RELAY_MODE: "relay-read-only",
    PROTRACTOR_RELAY_URL: relayUrl,
    PROTRACTOR_RELAY_HMAC_SECRET: secret,
  }),
  /must be relay/,
);
assert.throws(
  () => readProtractorRelayConfig({ PROTRACTOR_RELAY_REQUIRED: "yes" }),
  /must be true or false/,
);

for (const env of [
  { PROTRACTOR_RELAY_MODE: "other" },
  { PROTRACTOR_RELAY_MODE: "relay", PROTRACTOR_RELAY_URL: relayUrl },
  {
    PROTRACTOR_RELAY_MODE: "relay",
    PROTRACTOR_RELAY_URL: "http://protractor-relay.mos.tools/relay",
    PROTRACTOR_RELAY_HMAC_SECRET: secret,
  },
  {
    PROTRACTOR_RELAY_MODE: "relay",
    PROTRACTOR_RELAY_URL: `${relayUrl}?unsafe=1`,
    PROTRACTOR_RELAY_HMAC_SECRET: secret,
  },
  {
    PROTRACTOR_RELAY_MODE: "relay",
    PROTRACTOR_RELAY_URL: "https://evil.example/relay",
    PROTRACTOR_RELAY_HMAC_SECRET: secret,
  },
]) {
  assert.throws(() => readProtractorRelayConfig(env), /PROTRACTOR_RELAY_/);
}

const readOnly = readProtractorRelayConfig({
  PROTRACTOR_RELAY_MODE: "relay-read-only",
  PROTRACTOR_RELAY_URL: relayUrl,
  PROTRACTOR_RELAY_HMAC_SECRET: secret,
});
const restTarget = new URL("https://integration.protractor.com/IntegrationServices/2.0/Vehicle");
const soapReadTarget = new URL("https://integration.protractor.com/IntegrationServices/1.0/ContactServices.asmx");
assert.equal(shouldUseProtractorRelay(readOnly, restTarget, "GET", {}), true);
assert.equal(shouldUseProtractorRelay(readOnly, restTarget, "POST", {}), false);
assert.equal(shouldUseProtractorRelay(readOnly, soapReadTarget, "GET", {}), false);

assert.equal(classifyProtractorEndpoint("/WorkOrder/private-id?vin=secret", "rest"), "work_order");
assert.equal(classifyProtractorEndpoint("/Invoice/private-id?customer=secret", "rest"), "invoice");
assert.equal(
  classifyProtractorEndpoint(
    "https://integration.protractor.com/IntegrationServices/2.0/Vehicle/private-id?vin=secret",
    "rest",
  ),
  "vehicle",
);
assert.equal(classifyProtractorEndpoint("/ServicePackageTemplate/private-id", "rest"), "service_package_template");
assert.equal(classifyProtractorEndpoint(soapReadTarget, "soap"), "soap");
assert.equal(classifyProtractorEndpoint("/PrivateCustomerName/private-id?vin=secret", "rest"), "other");
assert.equal(new RelayTransportError("upstream_response_too_large").code, "upstream_response_too_large");
assert.equal(new RelayTransportError("provider-controlled-value").code, "upstream_error");
assert.equal(
  readProtractorRelayErrorCode({ "x-relay-error-code": "upstream_response_too_large" }),
  "upstream_response_too_large",
);
assert.equal(
  readProtractorRelayErrorCode({ "X-Relay-Error-Code": "upstream_response_too_large!" }),
  "upstream_error",
);
assert.equal(readProtractorRelayErrorCode({}), undefined);

const fixedRandom = (size: number) => Buffer.alloc(size, 7);
const originalHeaders = {
  connectionid: "connection-secret",
  apikey: "api-secret",
  authentication: "auth-secret",
  Accept: "application/json",
};
const plan = createProtractorRelayRequest(
  relayConfig(),
  "https://integration.protractor.com/IntegrationServices/2.0/WorkOrder/a%2Fb?x=a%2Bb&x=two",
  "PATCH",
  originalHeaders,
  '{"exact":"bytes\\n"}',
  1_000,
  1_700_000_000_999,
  fixedRandom,
);
assert.equal(plan.url.href, relayUrl);
assert.equal(plan.timeoutMs, 1_000);
assert.equal(plan.metadata.type, "rest");
assert.equal("shopId" in plan.metadata, false);
assert.equal("endpointClass" in plan.metadata, false);
const payload = JSON.parse(plan.body);
assert.deepEqual(payload, {
  type: "rest",
  method: "PATCH",
  path: "/IntegrationServices/2.0/WorkOrder/a%2Fb?x=a%2Bb&x=two",
  headers: originalHeaders,
  deadlineAtMs: 1_700_000_001_999,
  body: '{"exact":"bytes\\n"}',
});
assert.equal(plan.headers["content-length"], String(Buffer.byteLength(plan.body)));
const bodyHash = crypto.createHash("sha256").update(plan.body).digest("hex");
const canonical = [
  plan.headers["x-relay-timestamp"],
  plan.headers["x-relay-nonce"],
  plan.headers["x-relay-request-id"],
  "POST",
  "/relay",
  bodyHash,
].join("\n");
assert.equal(
  plan.headers["x-relay-signature"],
  `sha256=${crypto.createHmac("sha256", secret).update(canonical).digest("hex")}`,
);
assert.match(plan.headers["x-relay-nonce"], /^[A-Za-z0-9_-]{16,128}$/);
assert.match(plan.headers["x-relay-request-id"], /^[A-Za-z0-9._:-]{8,128}$/);

const soapTarget = new URL(
  "https://integration.protractor.com/IntegrationServices/1.0/WorkOrderServices.asmx",
);
assert.equal(classifyProtractorRequest(soapTarget, { "Content-Type": "text/xml; charset=utf-8" }), "soap");
const soap = createProtractorRelayRequest(
  relayConfig(),
  soapTarget.href,
  "POST",
  { SOAPAction: "update", "Content-Type": "text/xml" },
  "<exact />",
  5_000,
  1_700_000_000_000,
  fixedRandom,
);
assert.equal(soap.timeoutMs, 5_000);
assert.equal(JSON.parse(soap.body).type, "soap");
assert.equal(JSON.parse(soap.body).deadlineAtMs, 1_700_000_005_000);
const slowPriorityRest = createProtractorRelayRequest(
  relayConfig(),
  restTarget.href,
  "GET",
  {},
  undefined,
  65_000,
  1_700_000_000_000,
  fixedRandom,
);
assert.equal(
  slowPriorityRest.timeoutMs,
  65_000,
  "priority REST callers must outlive the relay's 60-second upstream deadline",
);
const protractorClientSource = readFileSync(
  join(__dirname, "../lib/integrations/protractor/client.ts"),
  "utf8",
);
const addToRoRouteSource = readFileSync(
  join(__dirname, "../app/api/jobs/add-to-ro/route.ts"),
  "utf8",
);
assert.doesNotMatch(
  addToRoRouteSource,
  /SOAP also failed[^]*soapResult\.error/,
  "add-to-RO logs must not include SOAP provider error text",
);
const fetchByIdSource = protractorClientSource.slice(
  protractorClientSource.indexOf("export async function fetchWorkOrderById"),
  protractorClientSource.indexOf("export type ProtractorActiveInspection"),
);
assert.match(
  fetchByIdSource,
  /opts\.timeoutMs \?\? 65_000/,
  "priority work-order reads must request the 65-second caller deadline",
);
assert.match(
  fetchByIdSource,
  /opts\.maxRetries \?\? 1/,
  "priority work-order reads must cap retries",
);
assert.throws(
  () => createProtractorRelayRequest(
    relayConfig(),
    "https://example.com/IntegrationServices/1.0/Contact",
    "GET",
    {},
    undefined,
    30_000,
  ),
  /Protractor HTTPS origin/,
);

console.log("protractor relay transport smoke tests passed");