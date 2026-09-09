import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  classifyProtractorRequest,
  createProtractorRelayRequest,
  readProtractorRelayConfig,
  shouldUseProtractorRelay,
} from "../lib/integrations/protractor/relay-transport";

const secret = "s".repeat(32);
const relayUrl = "https://protractor-relay.mos.tools/relay";

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
const payload = JSON.parse(plan.body);
assert.deepEqual(payload, {
  type: "rest",
  method: "PATCH",
  path: "/IntegrationServices/2.0/WorkOrder/a%2Fb?x=a%2Bb&x=two",
  headers: originalHeaders,
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