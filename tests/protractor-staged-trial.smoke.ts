/**
 * Offline coverage for the activation-started Protractor callback trial.
 *
 * Every provider/lease operation below is mocked. The test deliberately uses
 * persisted-event timestamps as the callback transport input so a worker clock
 * cannot accidentally make a stale callback eligible.
 */
import assert from "node:assert/strict";
import {
  __protractorClientTestHooks,
  getEffectiveProtractorOutboundPolicy,
  protractorFetch,
  runWithProtractorCallbackTransport,
  soapAddServicePackage,
  type ProtractorConfig,
} from "../lib/integrations/protractor/client";
import { evaluateProtractorOutboundPolicy } from "../lib/integrations/protractor/outbound-policy.cjs";

const POLICY_ENV_KEYS = [
  "RENDER_INSTANCE_ID",
  "PROTRACTOR_OUTBOUND_DISABLED",
  "PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS",
  "PROTRACTOR_CALLBACK_CANARY_UNTIL",
  "PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE",
  "PROTRACTOR_CALLBACK_TRIAL_ENABLED",
] as const;

const config: ProtractorConfig = {
  shopId: 1,
  connectionId: "staged-trial-test-connection",
  apiKey: "test-key",
  authentication: "test-auth",
  configured: true,
};

function canonical(ms: number): string {
  return new Date(ms).toISOString();
}

function timedTrial(startedAt: Date, expiresAt: Date, generation = "trial-generation"): any {
  return {
    mode: "timed_trial",
    generation,
    startedAt,
    expiresAt,
    maxAdmissions: null,
    consumedAdmissions: 0,
    remainingAdmissions: null,
    endedBy: undefined,
    endedAt: undefined,
  };
}

async function main(): Promise<void> {
  const previousEnv = new Map(
    POLICY_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const originalHooks = {
    httpsRequest: __protractorClientTestHooks.httpsRequest,
    enforceLocalPolicyWithMockTransport:
      __protractorClientTestHooks.enforceLocalPolicyWithMockTransport,
    enforceFleetPacerWithMockTransport:
      __protractorClientTestHooks.enforceFleetPacerWithMockTransport,
    acquireDistributedRateLimitSlot:
      __protractorClientTestHooks.acquireDistributedRateLimitSlot,
    acquireCallbackTransportLease:
      __protractorClientTestHooks.acquireCallbackTransportLease,
    releaseCallbackTransportLease:
      __protractorClientTestHooks.releaseCallbackTransportLease,
    acquirePhysicalTransportLease:
      __protractorClientTestHooks.acquirePhysicalTransportLease,
    confirmPhysicalTransportLease:
      __protractorClientTestHooks.confirmPhysicalTransportLease,
    renewPhysicalTransportLease:
      __protractorClientTestHooks.renewPhysicalTransportLease,
    releasePhysicalTransportLease:
      __protractorClientTestHooks.releasePhysicalTransportLease,
    physicalTransportHeartbeatMs:
      __protractorClientTestHooks.physicalTransportHeartbeatMs,
    trackApiRequest: __protractorClientTestHooks.trackApiRequest,
    acquireOutboundGate: __protractorClientTestHooks.acquireOutboundGate,
    resolveProtractorConfig: __protractorClientTestHooks.resolveProtractorConfig,
    recordResponse: __protractorClientTestHooks.recordResponse,
    sleep: __protractorClientTestHooks.sleep,
    now: __protractorClientTestHooks.now,
    getOperatorStop: __protractorClientTestHooks.getOperatorStop,
  };

  const baseNow = Date.now();
  const baseEnv = { RENDER_INSTANCE_ID: "staged-trial-test-instance" };
  const envForPolicy = (extra: Record<string, string> = {}) => ({
    ...baseEnv,
    ...extra,
  });

  try {
    for (const key of POLICY_ENV_KEYS) delete process.env[key];
    process.env.RENDER_INSTANCE_ID = baseEnv.RENDER_INSTANCE_ID;

    console.log("Scenario 1: staged policy is strict, callback-only, and clock-free");
    const staged = evaluateProtractorOutboundPolicy(
      envForPolicy({ PROTRACTOR_CALLBACK_TRIAL_ENABLED: "true" }),
      baseNow - 60_000,
    );
    assert.equal(staged.allowed, true);
    assert.equal(staged.callbackOnly, true);
    assert.equal(staged.requireTimedTrial, true);
    assert.equal(staged.callbackNotBeforeMs, null);

    assert.equal(
      evaluateProtractorOutboundPolicy(
        envForPolicy({ PROTRACTOR_CALLBACK_TRIAL_ENABLED: "wat" }),
        baseNow,
      ).allowed,
      false,
      "malformed staged flag must fail closed",
    );
    assert.equal(
      evaluateProtractorOutboundPolicy(
        envForPolicy({
          PROTRACTOR_CALLBACK_TRIAL_ENABLED: "true",
          PROTRACTOR_CALLBACK_CANARY_UNTIL: canonical(baseNow + 60_000),
        }),
        baseNow,
      ).allowed,
      false,
      "staged and legacy canary modes must not be combined",
    );
    assert.equal(
      evaluateProtractorOutboundPolicy(
        envForPolicy({
          PROTRACTOR_CALLBACK_TRIAL_ENABLED: "true",
          PROTRACTOR_OUTBOUND_DISABLED: "true",
        }),
        baseNow,
      ).reason,
      "service_disabled",
      "the emergency outbound stop must win over every trial mode",
    );
    const legacy = evaluateProtractorOutboundPolicy(
      envForPolicy({
        PROTRACTOR_CALLBACK_CANARY_UNTIL: canonical(baseNow + 60_000),
        PROTRACTOR_CALLBACK_REPLAY_NOT_BEFORE: canonical(baseNow - 1_000),
      }),
      baseNow,
    );
    assert.equal(legacy.allowed, true);
    assert.equal(legacy.callbackOnly, true);
    assert.equal(legacy.requireTimedTrial, false);

    console.log("Scenario 2: only staged mode reads the live Mongo trial state");
    let nowMs = baseNow;
    let stopReads = 0;
    __protractorClientTestHooks.now = () => nowMs;
    __protractorClientTestHooks.getOperatorStop = async () => {
      stopReads++;
      return {
        active: false,
        canary: timedTrial(
          new Date(baseNow - 1_000),
          new Date(baseNow + 1_800_000),
        ),
      } as any;
    };

    delete process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED;
    const ordinary = await getEffectiveProtractorOutboundPolicy();
    assert.equal(ordinary.allowed, true);
    assert.equal(stopReads, 0, "ordinary policy must not read the operator-stop store");

    process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED = "true";
    const live = await getEffectiveProtractorOutboundPolicy();
    assert.equal(live.allowed, true);
    assert.equal(live.requireTimedTrial, true);
    assert.equal(live.callbackNotBeforeMs, baseNow - 1_000);
    assert.equal(stopReads, 1);

    __protractorClientTestHooks.getOperatorStop = async () => ({
      active: false,
      canary: undefined,
    } as any);
    assert.equal((await getEffectiveProtractorOutboundPolicy()).allowed, false);

    __protractorClientTestHooks.getOperatorStop = async () => ({
      active: false,
      canary: timedTrial(
        new Date(baseNow - 1_000),
        new Date(baseNow - 1),
      ),
    } as any);
    assert.equal((await getEffectiveProtractorOutboundPolicy()).allowed, false);

    __protractorClientTestHooks.getOperatorStop = async () => {
      throw new Error("offline coordinator failure");
    };
    assert.equal((await getEffectiveProtractorOutboundPolicy()).allowed, false);

    console.log("Scenario 3: non-callback and stale/future callbacks never reach transport");
    let transportSends = 0;
    let ownerToken: string | null = null;
    let tokenSequence = 0;
    let nextAllowedAt = 0;
    const confirmations: Array<{
      requireTimedTrial?: boolean;
      callbackReceivedAt?: Date;
    }> = [];
    const persistedReceivedAt = new Date(baseNow - 100);
    const trialStartedAt = new Date(baseNow - 500);

    __protractorClientTestHooks.enforceLocalPolicyWithMockTransport = true;
    __protractorClientTestHooks.enforceFleetPacerWithMockTransport = true;
    __protractorClientTestHooks.acquireDistributedRateLimitSlot = async () => ({
      acquired: true,
      waitedMs: 0,
      currentCount: 1,
    });
    __protractorClientTestHooks.acquireCallbackTransportLease = async () =>
      "callback-lease";
    __protractorClientTestHooks.releaseCallbackTransportLease = async () => {};
    __protractorClientTestHooks.acquirePhysicalTransportLease = async (deadlineMs) => {
      while (Date.now() < deadlineMs) {
        if (!ownerToken && Date.now() >= nextAllowedAt) {
          ownerToken = `physical-${++tokenSequence}`;
          return ownerToken;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return null;
    };
    __protractorClientTestHooks.confirmPhysicalTransportLease = async (
      token,
      context,
    ) => {
      confirmations.push({
        requireTimedTrial: context?.requireTimedTrial,
        callbackReceivedAt: context?.callbackReceivedAt,
      });
      if (token !== ownerToken) return false;
      const receivedAt = context?.callbackReceivedAt?.getTime() ?? Number.NaN;
      if (
        context?.requireTimedTrial === true &&
        (receivedAt < trialStartedAt.getTime() || receivedAt > Date.now())
      ) {
        return false;
      }
      return true;
    };
    __protractorClientTestHooks.renewPhysicalTransportLease = async (token) =>
      token === ownerToken;
    __protractorClientTestHooks.releasePhysicalTransportLease = async (token) => {
      assert.equal(token, ownerToken);
      ownerToken = null;
      nextAllowedAt = Date.now() + 2;
    };
    __protractorClientTestHooks.trackApiRequest = async () => {};
    __protractorClientTestHooks.acquireOutboundGate = async () => ({
      allowed: true,
      probe: false,
    });
    __protractorClientTestHooks.recordResponse = async () => {};
    __protractorClientTestHooks.resolveProtractorConfig = async () => config;
    __protractorClientTestHooks.sleep = async () => {};
    __protractorClientTestHooks.physicalTransportHeartbeatMs = 30_000;
    __protractorClientTestHooks.httpsRequest = async (url) => {
      transportSends++;
      return url.endsWith("WorkOrderServices.asmx")
        ? {
            statusCode: 200,
            body: "<WorkOrderUpdateResult>&lt;WorkOrder&gt;&lt;ServicePackage&gt;&lt;/ServicePackage&gt;</WorkOrderUpdateResult>",
          }
        : { statusCode: 200, body: "{}" };
    };
    __protractorClientTestHooks.getOperatorStop = async () => ({
      active: false,
      canary: timedTrial(
        trialStartedAt,
        new Date(baseNow + 1_800_000),
      ),
    } as any);
    __protractorClientTestHooks.now = () => Date.now();

    const outsideCallback = await protractorFetch(
      "/Invoice/non-callback",
      config,
      {},
      0,
      1,
      { maxRetries: 0 },
    );
    assert.equal(outsideCallback.ok, false);
    assert.equal(transportSends, 0);

    const stale = await runWithProtractorCallbackTransport(
      Date.now() + 10_000,
      () => protractorFetch("/Invoice/stale", config, {}, 0, 1, { maxRetries: 0 }),
      {
        callbackReceivedAt: new Date(trialStartedAt.getTime() - 1),
        requireTimedTrial: true,
      },
    );
    assert.equal(stale.ok, false);
    assert.equal(transportSends, 0);

    const future = await runWithProtractorCallbackTransport(
      Date.now() + 10_000,
      () => protractorFetch("/Invoice/future", config, {}, 0, 1, { maxRetries: 0 }),
      {
        callbackReceivedAt: new Date(Date.now() + 60_000),
        requireTimedTrial: true,
      },
    );
    assert.equal(future.ok, false);
    assert.equal(transportSends, 0);

    console.log("Scenario 4: timed-trial mode admits >3 mixed REST/SOAP callbacks");
    const mixed = await Promise.all([
      runWithProtractorCallbackTransport(
        Date.now() + 10_000,
        () => protractorFetch("/Invoice/staged-rest-1", config, {}, 0, 1, { maxRetries: 0 }),
        { callbackReceivedAt: persistedReceivedAt, requireTimedTrial: true },
      ),
      runWithProtractorCallbackTransport(
        Date.now() + 10_000,
        () => protractorFetch("/Invoice/staged-rest-2", config, {}, 0, 1, { maxRetries: 0 }),
        { callbackReceivedAt: persistedReceivedAt, requireTimedTrial: true },
      ),
      runWithProtractorCallbackTransport(
        Date.now() + 10_000,
        () => soapAddServicePackage(1, "staged-wo-1", {
          ID: "staged-wo-1",
          Type: "WorkOrder",
          ServicePackages: [],
        }),
        { callbackReceivedAt: persistedReceivedAt, requireTimedTrial: true },
      ),
      runWithProtractorCallbackTransport(
        Date.now() + 10_000,
        () => soapAddServicePackage(1, "staged-wo-2", {
          ID: "staged-wo-2",
          Type: "WorkOrder",
          ServicePackages: [],
        }),
        { callbackReceivedAt: persistedReceivedAt, requireTimedTrial: true },
      ),
    ]);
    assert.ok(mixed.every((result) => result.ok));
    assert.equal(transportSends, 4);
    assert.equal(confirmations.length, 6);
    assert.ok(confirmations.slice(-4).every((context) =>
      context.requireTimedTrial === true &&
      context.callbackReceivedAt?.getTime() === persistedReceivedAt.getTime(),
    ));
    assert.ok(
      confirmations.every((context) => context.callbackReceivedAt instanceof Date),
      "physical confirmation must receive persisted receivedAt, never a worker-clock fallback",
    );

    console.log("All staged Protractor trial checks passed");
  } finally {
    for (const key of POLICY_ENV_KEYS) {
      const prior = previousEnv.get(key);
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    __protractorClientTestHooks.httpsRequest = originalHooks.httpsRequest;
    __protractorClientTestHooks.enforceLocalPolicyWithMockTransport =
      originalHooks.enforceLocalPolicyWithMockTransport;
    __protractorClientTestHooks.enforceFleetPacerWithMockTransport =
      originalHooks.enforceFleetPacerWithMockTransport;
    __protractorClientTestHooks.acquireDistributedRateLimitSlot =
      originalHooks.acquireDistributedRateLimitSlot;
    __protractorClientTestHooks.acquireCallbackTransportLease =
      originalHooks.acquireCallbackTransportLease;
    __protractorClientTestHooks.releaseCallbackTransportLease =
      originalHooks.releaseCallbackTransportLease;
    __protractorClientTestHooks.acquirePhysicalTransportLease =
      originalHooks.acquirePhysicalTransportLease;
    __protractorClientTestHooks.confirmPhysicalTransportLease =
      originalHooks.confirmPhysicalTransportLease;
    __protractorClientTestHooks.renewPhysicalTransportLease =
      originalHooks.renewPhysicalTransportLease;
    __protractorClientTestHooks.releasePhysicalTransportLease =
      originalHooks.releasePhysicalTransportLease;
    __protractorClientTestHooks.physicalTransportHeartbeatMs =
      originalHooks.physicalTransportHeartbeatMs;
    __protractorClientTestHooks.trackApiRequest = originalHooks.trackApiRequest;
    __protractorClientTestHooks.acquireOutboundGate = originalHooks.acquireOutboundGate;
    __protractorClientTestHooks.resolveProtractorConfig =
      originalHooks.resolveProtractorConfig;
    __protractorClientTestHooks.recordResponse = originalHooks.recordResponse;
    __protractorClientTestHooks.sleep = originalHooks.sleep;
    __protractorClientTestHooks.now = originalHooks.now;
    __protractorClientTestHooks.getOperatorStop = originalHooks.getOperatorStop;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});