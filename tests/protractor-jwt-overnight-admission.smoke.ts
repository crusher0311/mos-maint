import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import {createMongoExpressionCollection} from "./helpers/mongo-expression-collection";
import {__protractorClientTestHooks as clientHooks, protractorFetch} from "../lib/integrations/protractor/client";
import {runWithJwtOvernightTransport} from "../lib/integrations/protractor/jwt-overnight-context";
import {compileJwtOvernightInvoiceRequest, type JwtOvernightGrant} from "../lib/protractor-jwt-overnight-policy";
import {
  __protractorPhysicalTransportTestHooks as hooks,
  confirmProtractorPhysicalTransportLease as confirm,
} from "../lib/data/repositories/api-usage";

const now = new Date("2026-10-06T04:00:00Z");
const generation = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const request = {runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", shopId: 233,
  day: "2026-09-01", method: "GET" as const, operation: "invoice-day" as const};
const grant = {version: 1, runId: request.runId, canaryGeneration: generation,
  manifestHash: "c".repeat(64), notBefore: new Date("2026-10-06T03:00:00Z"),
  expiresAt: new Date("2026-10-06T10:00:00Z"), windowKeys: ["233:2026-09-01"],
  maxRequests: 1, consumedRequests: 0, stopped: false};
function collection() {
  const col = createMongoExpressionCollection({
    _id: "protractor-physical-transport-v1", ownerToken: "lease", ownerCanaryGeneration: generation,
    leaseExpiresAt: new Date(now.getTime() + 60_000), operatorStop: {active: false},
    canary: {mode: "live", generation, scope: "callbacks_and_interactive", requiresCallback: false,
      requiresRelay: true, workersSuspendedConfirmed: true, startedAt: new Date("2026-10-05T00:00:00Z"),
      maxAdmissions: null, remainingAdmissions: null, consumedAdmissions: 0, audit: []},
    jwtOvernight: grant,
  }, {now: () => now});
  hooks.getDb = async () => ({collection: () => col}) as any;
  return col;
}
const context = {overnightRequest: request, requireTimedTrial: true,
  transport: "relay" as const, environment: "production" as const};
async function main() {
  const original = hooks.getDb;
  try {
    let col = collection();
    assert.deepEqual(await Promise.all([confirm("lease", context), confirm("lease", context)]), [true, false]);
    assert.equal(col.row.jwtOvernight.consumedRequests, 1);
    assert.equal(col.row.canary.consumedAdmissions, 1);
    col.row.ownerToken = "next";
    assert.equal(await confirm("next", context), false);
    assert.equal(col.row.jwtOvernight.consumedRequests, 1);
    assert.equal(await confirm("next", {...context, overnightRequest: undefined,
      callbackReceivedAt: now}), true, "Exhausting recovery must not block genuine callbacks");
    assert.equal(col.row.jwtOvernight.consumedRequests, 1);
    assert.equal(col.row.canary.consumedAdmissions, 2);
    for (const patch of [
      {interactiveShopId: 233}, {callbackReceivedAt: now},
      {transport: "direct"}, {environment: "development"},
      {overnightRequest: {...request, shopId: 227}},
      {overnightRequest: {...request, day: "2026-08-01"}},
      {overnightRequest: {...request, method: "POST"}},
    ]) {
      col = collection();
      assert.equal(await confirm("lease", {...context, ...patch} as any), false);
      assert.equal(col.row.jwtOvernight.consumedRequests, 0);
      assert.equal(col.row.canary.consumedAdmissions, 0);
    }
    for (const patch of [
      {stopped: true}, {expiresAt: now}, {notBefore: new Date(now.getTime() + 1)},
      {canaryGeneration: "old"}, {windowKeys: null}, {maxRequests: .5},
    ]) {
      col = collection();
      Object.assign(col.row.jwtOvernight, patch);
      assert.equal(await confirm("lease", context), false);
    }
    col = collection(); col.row.operatorStop.active = true;
    assert.equal(await confirm("lease", context), false);
    col = collection(); delete col.row.jwtOvernight;
    assert.equal(await confirm("lease", context), false);
    col = collection(); delete col.row.canary;
    assert.equal(await confirm("lease", {...context, requireTimedTrial: false}), false);

    // Full client -> physical confirmation -> mocked send. Network egress is
    // disabled above; production provenance here is synthetic test data only.
    const env = {...process.env};
    const oldNow = Date.now;
    const oldHooks = {...clientHooks};
    try {
      Date.now = () => now.getTime();
      delete process.env.REPLIT_DEV_DOMAIN;
      delete process.env.PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS;
      delete process.env.PROTRACTOR_CALLBACK_CANARY_UNTIL;
      delete process.env.PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE;
      process.env.PROTRACTOR_ENVIRONMENT = "production";
      process.env.PROTRACTOR_OUTBOUND_DISABLED = "false";
      process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED = "true";
      process.env.PROTRACTOR_RELAY_MODE = "relay";
      process.env.PROTRACTOR_RELAY_URL = "https://protractor-relay.mos.tools/relay";
      process.env.PROTRACTOR_RELAY_HMAC_SECRET = "synthetic-test-secret-not-a-credential".repeat(2);
      clientHooks.enforceFleetPacerWithMockTransport = true;
      clientHooks.enforceLocalPolicyWithMockTransport = true;
      clientHooks.now = () => now.getTime();
      clientHooks.acquireDistributedRateLimitSlot = async () => ({acquired: true, waitedMs: 0, currentCount: 1});
      clientHooks.acquireOutboundGate = async () => ({allowed: true, probe: false});
      clientHooks.recordResponse = async () => {};
      clientHooks.trackApiRequest = async () => {};
      clientHooks.acquirePhysicalTransportLease = async () => "lease";
      clientHooks.releasePhysicalTransportLease = async () => {};
      clientHooks.renewPhysicalTransportLease = async () => true;
      clientHooks.getOperatorStop = async () => ({active: false, canary: col.row.canary}) as any;
      let sends = 0;
      let observedDeadline: number | undefined;
      clientHooks.onFetchStart = (_endpoint, options) => {observedDeadline = options?.deadlineAtMs;};
      clientHooks.httpsRequest = async () => {
        sends++;
        return {statusCode: 200, body: '{"ItemCollection":[]}', transport: "relay"};
      };
      const config = {shopId: 233, configured: true, connectionId: "synthetic-connection",
        apiKey: "synthetic-key", authentication: "synthetic-auth"};
      const endpoint = compileJwtOvernightInvoiceRequest(request, 0).endpoint;
      col = collection();
      assert.equal((await protractorFetch(endpoint, config, {}, 0, 233, {maxRetries: 0})).ok, false);
      assert.equal(sends, 0, "Ordinary background work must remain blocked");
      await runWithJwtOvernightTransport(grant as JwtOvernightGrant, request, async () => {
        assert.equal((await protractorFetch("/Contact/", config, {}, 0, 233, {maxRetries: 0})).ok, false);
        assert.equal((await protractorFetch(endpoint, config, {method: "POST"}, 0, 233, {maxRetries: 0})).ok, false);
        assert.equal((await protractorFetch(endpoint, config, {headers: {connectionid: "other"}}, 0, 233,
          {maxRetries: 0})).ok, false);
        assert.equal((await protractorFetch(endpoint, config, {}, 0, 233,
          {priority: true, maxRetries: 0})).ok, false);
        const valid = await protractorFetch(endpoint, config, {}, 0, 233,
          {maxRetries: 0, deadlineAtMs: now.getTime() + 3600_000});
        assert.equal(valid.ok, true, JSON.stringify(valid));
      });
      assert.equal(sends, 1);
      assert.equal(observedDeadline, now.getTime() + 60_000);
      assert.equal(col.row.jwtOvernight.consumedRequests, 1);
      assert.equal(col.row.canary.consumedAdmissions, 1);
    } finally {
      Date.now = oldNow;
      Object.assign(clientHooks, oldHooks);
      for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
      Object.assign(process.env, env);
    }
    console.log("JWT overnight atomic admission: ownership, budget, stop, expiry and callback compatibility passed.");
  } finally { hooks.getDb = original; }
}
main().catch(e => {console.error(e); process.exitCode = 1;});
