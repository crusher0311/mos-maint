/**
 * Task #1275 — a shared timed trial cannot be consumed by a development
 * process that defaults to direct Protractor transport.
 *
 * This test owns a fake copy of the permanent physical safety record and never
 * resolves the application's Mongo URI.  A permanent transport-level egress
 * deny remains installed for the whole subprocess, so a failed admission
 * assertion cannot accidentally contact either Protractor or the relay.
 */
import assert from "node:assert/strict";
import {
  clearDeniedNetworkAttempts,
  deniedNetworkAttempts,
} from "./helpers/deny-network-egress";
import { createMongoExpressionCollection } from "./helpers/mongo-expression-collection";
import {
  __protractorClientTestHooks,
  getEffectiveProtractorOutboundPolicy,
  protractorFetch,
  runWithProtractorCallbackTransport,
} from "../lib/integrations/protractor/client";
import {
  __protractorPhysicalTransportTestHooks,
  getProtractorOperatorStop,
} from "../lib/data/repositories/api-usage";
import { runWithProtractorInteractiveTransport } from "../lib/integrations/protractor/interactive-context";

const ENV_KEYS = [
  "NODE_ENV",
  "RENDER",
  "RENDER_SERVICE_ID",
  "RENDER_INSTANCE_ID",
  "REPLIT_DEV_DOMAIN",
  "PROTRACTOR_CALLBACK_TRIAL_ENABLED",
  "PROTRACTOR_CALLBACK_CANARY_UNTIL",
  "PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE",
  "PROTRACTOR_OUTBOUND_DISABLED",
  "PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS",
  "PROTRACTOR_RELAY_MODE",
  "PROTRACTOR_RELAY_REQUIRED",
  "PROTRACTOR_RELAY_URL",
  "PROTRACTOR_RELAY_HMAC_SECRET",
  "PROTRACTOR_DEVELOPMENT_RELAY_APPROVED",
] as const;

const config = {
  shopId: 42,
  connectionId: "offline-task-1275-connection",
  apiKey: "offline-task-1275-key",
  authentication: "offline-task-1275-auth",
  configured: true,
};

const baseNow = Date.now();
const PHYSICAL_KEY = "protractor-physical-transport-v1";
const relayUrl = "https://protractor-relay.mos.tools/relay";
const relaySecret = "r".repeat(32);

type TrialScope = "callbacks" | "callbacks_and_interactive";

function sharedTrial(
  scope: TrialScope = "callbacks_and_interactive",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mode: "timed_trial",
    generation: "shared-task-1275-generation",
    scope,
    requiresCallback: scope === "callbacks",
    startedAt: new Date(baseNow - 1_000),
    // The production CAS treats the 30-minute duration as part of the trial
    // record's validity, not merely as an informational bound.
    expiresAt: new Date(baseNow + 30 * 60_000 - 1_000),
    maxAdmissions: null,
    consumedAdmissions: 0,
    remainingAdmissions: null,
    requiresRelay: true,
    audit: [],
    ...overrides,
  };
}

function freshPhysicalRow(
  scope: TrialScope = "callbacks_and_interactive",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: PHYSICAL_KEY,
    count: 0,
    nextAllowedAt: new Date(0),
    leaseExpiresAt: new Date(0),
    operatorStop: {
      active: false,
      stopId: "shared-task-1275-stop",
      reason: "offline shared trial",
      changedBy: "offline-test",
      updatedAt: new Date(baseNow - 2_000),
    },
    canary: sharedTrial(scope, overrides),
    canaryHistory: [],
  };
}

function clearPolicyEnvironment(): void {
  for (const key of ENV_KEYS) delete process.env[key];
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = "development";
  env.REPLIT_DEV_DOMAIN = "offline-task-1275.test";
  env.RENDER_INSTANCE_ID = "offline-task-1275-dev";
  env.PROTRACTOR_OUTBOUND_DISABLED = "false";
}

function relayApprovedEnvironment(extra: Record<string, string> = {}): void {
  clearPolicyEnvironment();
  const env = process.env as Record<string, string | undefined>;
  env.PROTRACTOR_CALLBACK_TRIAL_ENABLED = "true";
  env.PROTRACTOR_RELAY_REQUIRED = "true";
  env.PROTRACTOR_RELAY_MODE = "relay";
  env.PROTRACTOR_RELAY_URL = relayUrl;
  env.PROTRACTOR_RELAY_HMAC_SECRET = relaySecret;
  env.PROTRACTOR_DEVELOPMENT_RELAY_APPROVED = "true";
  Object.assign(env, extra);
}

function deniedEnvironment(
  settings: Record<string, string | undefined> = {},
  runtime: "development" | "production" = "development",
): void {
  clearPolicyEnvironment();
  const env = process.env as Record<string, string | undefined>;
  if (runtime === "production") {
    delete env.REPLIT_DEV_DOMAIN;
    env.NODE_ENV = "production";
  }
  Object.assign(env, settings);
}

type TrialCollection = ReturnType<typeof createMongoExpressionCollection>;

function installTrialCollection(collection: TrialCollection): void {
  __protractorPhysicalTransportTestHooks.getDb = async () => ({
    collection: () => collection,
  } as any);
  __protractorClientTestHooks.getOperatorStop = () => getProtractorOperatorStop();
}

async function runInteractiveAttempt(): Promise<{ ok: boolean; error?: string }> {
  return runWithProtractorInteractiveTransport(42, () =>
    protractorFetch(
      "/Invoice/task-1275",
      config,
      {},
      0,
      42,
      { priority: true, maxRetries: 0 },
    ),
  );
}

async function runCallbackAttempt(): Promise<{ ok: boolean; error?: string }> {
  return runWithProtractorCallbackTransport(
    baseNow + 10_000,
    () => protractorFetch(
      "/Invoice/task-1275-callback",
      config,
      {},
      0,
      42,
      { maxRetries: 0 },
    ),
    {
      callbackReceivedAt: new Date(baseNow - 500),
      requireTimedTrial: true,
    },
  );
}

function admissionCount(collection: TrialCollection): number {
  return collection.row.canary?.consumedAdmissions ?? -1;
}

async function main(): Promise<void> {
  const originalEnvironment = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  const originalPhysicalHooks = {
    getDb: __protractorPhysicalTransportTestHooks.getDb,
    randomUUID: __protractorPhysicalTransportTestHooks.randomUUID,
  };
  const originalClientHooks = {
    getOperatorStop: __protractorClientTestHooks.getOperatorStop,
    acquireDistributedRateLimitSlot: __protractorClientTestHooks.acquireDistributedRateLimitSlot,
    acquireCallbackTransportLease: __protractorClientTestHooks.acquireCallbackTransportLease,
    releaseCallbackTransportLease: __protractorClientTestHooks.releaseCallbackTransportLease,
    acquireOutboundGate: __protractorClientTestHooks.acquireOutboundGate,
    recordResponse: __protractorClientTestHooks.recordResponse,
    now: __protractorClientTestHooks.now,
    sleep: __protractorClientTestHooks.sleep,
    resolveProtractorConfig: __protractorClientTestHooks.resolveProtractorConfig,
    getDb: __protractorClientTestHooks.getDb,
    enforceLocalPolicyWithMockTransport:
      __protractorClientTestHooks.enforceLocalPolicyWithMockTransport,
    enforceFleetPacerWithMockTransport:
      __protractorClientTestHooks.enforceFleetPacerWithMockTransport,
  };

  try {
    clearPolicyEnvironment();
    __protractorClientTestHooks.now = () => baseNow;
    __protractorClientTestHooks.sleep = async () => {};
    __protractorClientTestHooks.resolveProtractorConfig = async () => config;
    __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
      acquired: true,
      waitedMs: 0,
      currentCount: 0,
    });
    __protractorClientTestHooks.acquireCallbackTransportLease = async () =>
      "offline-task-1275-callback-lease";
    __protractorClientTestHooks.releaseCallbackTransportLease = async () => {};
    __protractorClientTestHooks.acquireOutboundGate = async () => ({
      allowed: true,
      probe: false,
    });
    __protractorClientTestHooks.recordResponse = async () => {};
    __protractorClientTestHooks.enforceLocalPolicyWithMockTransport = true;
    __protractorClientTestHooks.enforceFleetPacerWithMockTransport = true;
    __protractorPhysicalTransportTestHooks.randomUUID = (() => {
      let sequence = 0;
      return () => `offline-task-1275-owner-${++sequence}`;
    })();

    console.log("Scenario 1: direct/default/missing local staging settings cannot consume a shared trial");
    for (const scenario of [
      {
        name: "explicit direct mode",
        settings: {
          PROTRACTOR_RELAY_MODE: "direct",
          PROTRACTOR_CALLBACK_TRIAL_ENABLED: "true",
        },
        runtime: "development" as const,
      },
      {
        name: "default relay mode",
        settings: { PROTRACTOR_CALLBACK_TRIAL_ENABLED: "true" } as Record<string, string>,
        runtime: "development" as const,
      },
      {
        name: "missing staging settings",
        settings: {},
        runtime: "development" as const,
      },
      {
        name: "production explicit direct mode",
        settings: { PROTRACTOR_RELAY_MODE: "direct" },
        runtime: "production" as const,
      },
      {
        name: "production default relay mode",
        settings: {},
        runtime: "production" as const,
      },
      {
        name: "production missing staging settings",
        settings: {},
        runtime: "production" as const,
      },
    ]) {
      const collection = createMongoExpressionCollection(freshPhysicalRow());
      installTrialCollection(collection);
      deniedEnvironment(scenario.settings, scenario.runtime);
      clearDeniedNetworkAttempts();

      const result = await runInteractiveAttempt();
      assert.equal(
        result.ok,
        false,
        `${scenario.name}: development foreground traffic must be denied`,
      );
      assert.equal(
        admissionCount(collection),
        0,
        `${scenario.name}: a denied preview request must not consume shared admission`,
      );
      assert.equal(
        deniedNetworkAttempts().length,
        0,
        `${scenario.name}: denial must happen before any physical dispatch`,
      );
    }

    const legacyCollection = createMongoExpressionCollection(freshPhysicalRow());
    delete legacyCollection.row.canary.requiresRelay;
    installTrialCollection(legacyCollection);
    deniedEnvironment({ PROTRACTOR_RELAY_MODE: "direct" }, "production");
    clearDeniedNetworkAttempts();
    const legacyPolicy = await runWithProtractorInteractiveTransport(
      42,
      () => getEffectiveProtractorOutboundPolicy(),
    );
    assert.equal(
      legacyPolicy.relayRequired,
      true,
      "an active legacy timed trial must default to relay-only without a migration",
    );
    const legacyAttempt = await runInteractiveAttempt();
    assert.equal(legacyAttempt.ok, false);
    assert.equal(admissionCount(legacyCollection), 0);
    assert.equal(
      deniedNetworkAttempts().length,
      0,
      "legacy active trial closure must happen before physical dispatch",
    );

    console.log("Scenario 2: explicit relay approval is the only development dispatch path");
    const approvedCollection = createMongoExpressionCollection(freshPhysicalRow());
    installTrialCollection(approvedCollection);
    relayApprovedEnvironment();
    clearDeniedNetworkAttempts();
    const approved = await runInteractiveAttempt();
    assert.equal(approved.ok, false, "the permanent egress deny must stop the relay attempt");
    assert.equal(
      admissionCount(approvedCollection),
      1,
      "an explicitly approved relay request may consume one physical admission",
    );
    assert.equal(deniedNetworkAttempts().length, 1, "the approved path must reach the network boundary");
    assert.equal(
      (deniedNetworkAttempts()[0].target as any)?.hostname,
      "protractor-relay.mos.tools",
      "development approval must dispatch to the relay, never the provider",
    );

    console.log("Scenario 3: callback scope, shop fence, expiry, and operator stop remain fail-closed");
    relayApprovedEnvironment();

    const callbackOnlyCollection = createMongoExpressionCollection(
      freshPhysicalRow("callbacks"),
    );
    installTrialCollection(callbackOnlyCollection);
    clearDeniedNetworkAttempts();
    const interactiveInCallbackOnlyTrial = await runInteractiveAttempt();
    assert.equal(interactiveInCallbackOnlyTrial.ok, false);
    assert.equal(admissionCount(callbackOnlyCollection), 0);
    assert.equal(deniedNetworkAttempts().length, 0);

    const callbackCollection = createMongoExpressionCollection(
      freshPhysicalRow("callbacks"),
    );
    installTrialCollection(callbackCollection);
    clearDeniedNetworkAttempts();
    const callback = await runCallbackAttempt();
    assert.equal(callback.ok, false, "network denial must stop the callback relay attempt");
    assert.equal(admissionCount(callbackCollection), 1);
    assert.equal(deniedNetworkAttempts().length, 1);
    assert.equal(
      (deniedNetworkAttempts()[0].target as any)?.hostname,
      "protractor-relay.mos.tools",
    );

    const wrongShopCollection = createMongoExpressionCollection(
      freshPhysicalRow("callbacks_and_interactive"),
    );
    installTrialCollection(wrongShopCollection);
    clearDeniedNetworkAttempts();
    const wrongShop = await runWithProtractorInteractiveTransport(43, () =>
      protractorFetch("/Invoice/task-1275-wrong-shop", config, {}, 0, 42, {
        priority: true,
        maxRetries: 0,
      }),
    );
    assert.equal(wrongShop.ok, false);
    assert.equal(admissionCount(wrongShopCollection), 0, "shop fence must precede admission");
    assert.equal(deniedNetworkAttempts().length, 0);

    const expiredCollection = createMongoExpressionCollection(
      freshPhysicalRow("callbacks_and_interactive", {
        expiresAt: new Date(baseNow - 1),
      }),
    );
    installTrialCollection(expiredCollection);
    clearDeniedNetworkAttempts();
    const expired = await runInteractiveAttempt();
    assert.equal(expired.ok, false);
    assert.equal(admissionCount(expiredCollection), 0, "expired trial must not consume admission");
    assert.equal(deniedNetworkAttempts().length, 0);

    const stoppedCollection = createMongoExpressionCollection(freshPhysicalRow());
    stoppedCollection.row.operatorStop.active = true;
    installTrialCollection(stoppedCollection);
    clearDeniedNetworkAttempts();
    const stopped = await runInteractiveAttempt();
    assert.equal(stopped.ok, false);
    assert.equal(admissionCount(stoppedCollection), 0, "operator stop must remain authoritative");
    assert.equal(deniedNetworkAttempts().length, 0);

    console.log("Scenario 4: effective policy reads shared state without relying on a local staging flag");
    const policyCollection = createMongoExpressionCollection(freshPhysicalRow());
    installTrialCollection(policyCollection);
    deniedEnvironment({}, "production");
    const policy = await runWithProtractorInteractiveTransport(
      42,
      () => getEffectiveProtractorOutboundPolicy(),
    );
    assert.equal(policy.allowed, true);
    assert.equal(policy.relayRequired, true);
    assert.equal(policyCollection.calls.some(call => call.method === "findOne"), true);

    deniedEnvironment();
    const developmentPolicy = await getEffectiveProtractorOutboundPolicy();
    assert.equal(developmentPolicy.allowed, false);
    assert.equal(
      developmentPolicy.reason,
      "development_relay_required",
      "development traffic must require explicit relay approval even when local staging settings are missing",
    );

    console.log("Task #1275 offline Protractor relay-boundary checks passed");
  } finally {
    __protractorPhysicalTransportTestHooks.getDb = originalPhysicalHooks.getDb;
    __protractorPhysicalTransportTestHooks.randomUUID = originalPhysicalHooks.randomUUID;
    __protractorClientTestHooks.getOperatorStop = originalClientHooks.getOperatorStop;
    __protractorClientTestHooks.acquireDistributedRateLimitSlot =
      originalClientHooks.acquireDistributedRateLimitSlot;
    __protractorClientTestHooks.acquireCallbackTransportLease =
      originalClientHooks.acquireCallbackTransportLease;
    __protractorClientTestHooks.releaseCallbackTransportLease =
      originalClientHooks.releaseCallbackTransportLease;
    __protractorClientTestHooks.acquireOutboundGate = originalClientHooks.acquireOutboundGate;
    __protractorClientTestHooks.recordResponse = originalClientHooks.recordResponse;
    __protractorClientTestHooks.now = originalClientHooks.now;
    __protractorClientTestHooks.sleep = originalClientHooks.sleep;
    __protractorClientTestHooks.resolveProtractorConfig = originalClientHooks.resolveProtractorConfig;
    __protractorClientTestHooks.getDb = originalClientHooks.getDb;
    __protractorClientTestHooks.enforceLocalPolicyWithMockTransport =
      originalClientHooks.enforceLocalPolicyWithMockTransport;
    __protractorClientTestHooks.enforceFleetPacerWithMockTransport =
      originalClientHooks.enforceFleetPacerWithMockTransport;
    for (const key of ENV_KEYS) {
      const prior = originalEnvironment.get(key);
      if (prior === undefined) delete process.env[key];
      else (process.env as Record<string, string | undefined>)[key] = prior;
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});