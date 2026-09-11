/**
 * Offline API regression coverage for the activation-started Protractor trial.
 *
 * Run with:
 *   NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
 *     npx tsx tests/protractor-timed-trial-api.smoke.ts
 *
 * The route dependencies are replaced through its test seam. No auth session,
 * Mongo, audit store, alert provider, or network request is used.
 */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET, POST } from "../app/api/platform-admin/protractor-operator-stop/route";
import { deps } from "../app/api/platform-admin/protractor-operator-stop/deps";

type Doc = Record<string, any>;

const ENV_KEYS = [
  "RENDER_SERVICE_ID",
  "PROTRACTOR_CALLBACK_TRIAL_ENABLED",
  "PROTRACTOR_CALLBACK_CANARY_UNTIL",
  "PROTRACTOR_OUTBOUND_DISABLED",
  "PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS",
  "PROTRACTOR_RELAY_REQUIRED",
  "PROTRACTOR_RELAY_MODE",
  "RENDER_INSTANCE_ID",
] as const;

const PRODUCTION_SERVICE_ID = "srv-d55jaqkhg0os73a5dd8g";

function post(body: Doc): NextRequest {
  return new NextRequest("http://localhost/api/platform-admin/protractor-operator-stop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function state(overrides: Doc = {}): Doc {
  return {
    active: true,
    stopId: "stop-current",
    physicalAdmissionInFlight: false,
    canary: null,
    canaryHistory: [],
    ...overrides,
  };
}

function readyEnvironment(): void {
  process.env.RENDER_SERVICE_ID = PRODUCTION_SERVICE_ID;
  process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED = "true";
  delete process.env.PROTRACTOR_CALLBACK_CANARY_UNTIL;
  process.env.PROTRACTOR_OUTBOUND_DISABLED = "false";
  delete process.env.PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS;
  process.env.PROTRACTOR_RELAY_REQUIRED = "true";
  process.env.PROTRACTOR_RELAY_MODE = "relay";
  delete process.env.RENDER_INSTANCE_ID;
}

async function responseBody(response: Response): Promise<Doc> {
  return response.json() as Promise<Doc>;
}

async function main(): Promise<void> {
  const originalEnvironment = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  const originalDeps = { ...deps };
  let authenticated = false;
  let currentState = state();
  let startCalls: Doc[] = [];
  let auditCalls: Doc[] = [];
  let alertCalls: Doc[] = [];
  let startError: Error | null = null;

  Object.assign(deps, {
    requirePlatformAdmin: async () => {
      if (!authenticated) throw new Error("Unauthorized");
      return { email: "operator@example.com" };
    },
    getProtractorOperatorStop: async () => currentState,
    startProtractorTimedTrial: async (input: Doc) => {
      startCalls.push(input);
      if (startError) throw startError;
      const scope = input.scope ?? "callbacks";
      currentState = state({
        active: false,
        canary: {
          mode: "timed_trial",
          scope,
          requiresCallback: scope === "callbacks",
          startedAt: new Date("2026-09-11T12:00:00.000Z"),
          expiresAt: new Date("2026-09-11T12:30:00.000Z"),
          maxAdmissions: null,
          consumedAdmissions: 0,
          remainingAdmissions: null,
          audit: [],
        },
      });
      return currentState;
    },
    activateProtractorOperatorStop: async () => currentState,
    clearProtractorOperatorStop: async () => currentState,
    logAdminAction: async (input: Doc) => {
      auditCalls.push(input);
    },
    sendOpsAlert: async (input: Doc) => {
      alertCalls.push(input);
    },
  });

  try {
    console.log("Protractor timed-trial API offline checks");

    for (const key of ENV_KEYS) delete process.env[key];
    authenticated = false;
    let response = await POST(post({
      action: "start_trial",
      reason: "approved trial",
      expectedStopId: "stop-current",
      workersSuspendedConfirmed: true,
    }));
    assert.equal(response.status, 401, "unauthenticated mutation must be rejected");
    assert.equal(startCalls.length, 0);

    authenticated = true;
    process.env.RENDER_SERVICE_ID = "srv-non-production";
    response = await POST(post({
      action: "start_trial",
      reason: "approved trial",
      expectedStopId: "stop-current",
      workersSuspendedConfirmed: true,
    }));
    assert.equal(response.status, 403, "trial mutation must be production-only");
    assert.equal(startCalls.length, 0);

    readyEnvironment();
    const readinessCases = [
      ["true", "true", "true", "relay", "outbound must be explicitly enabled"],
      ["true", "false", "false", "relay", "relay must be required"],
      ["true", "false", "true", "relay-read-only", "non-write relay mode must be rejected"],
    ] as const;
    for (const [enabled, outboundDisabled, relayRequired, relayMode, message] of readinessCases) {
      process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED = enabled;
      process.env.PROTRACTOR_OUTBOUND_DISABLED = outboundDisabled;
      process.env.PROTRACTOR_RELAY_REQUIRED = relayRequired;
      process.env.PROTRACTOR_RELAY_MODE = relayMode;
      response = await POST(post({
        action: "start_trial",
        reason: "approved trial",
        expectedStopId: "stop-current",
        workersSuspendedConfirmed: true,
      }));
      assert.equal(response.status, 409, message);
    }
    process.env.PROTRACTOR_CALLBACK_CANARY_UNTIL = "2026-09-11T12:15:00.000Z";
    response = await POST(post({
      action: "start_trial",
      reason: "legacy conflict",
      expectedStopId: "stop-current",
      workersSuspendedConfirmed: true,
    }));
    assert.equal(response.status, 409, "legacy wall-clock canary must conflict with timed trial mode");
    assert.equal(
      (await responseBody(response)).error,
      "Protractor outbound policy denied: conflicting_callback_trial_policy",
    );
    delete process.env.PROTRACTOR_CALLBACK_CANARY_UNTIL;
    for (const [denyList, identity, reason] of [
      ["[", undefined, "malformed_policy"],
      ["instance-a", undefined, "missing_identity"],
      ["instance-a", "instance-a", "denied_instance"],
    ] as const) {
      process.env.PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS = denyList;
      if (identity) process.env.RENDER_INSTANCE_ID = identity;
      else delete process.env.RENDER_INSTANCE_ID;
      response = await POST(post({
        action: "start_trial",
        reason: "fleet policy denial",
        expectedStopId: "stop-current",
        workersSuspendedConfirmed: true,
      }));
      assert.equal(response.status, 409, `policy ${reason} must block start`);
      assert.equal(
        (await responseBody(response)).error,
        `Protractor outbound policy denied: ${reason}`,
      );
    }
    delete process.env.PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS;
    delete process.env.RENDER_INSTANCE_ID;
    assert.equal(startCalls.length, 0, "readiness failures must not invoke the repository");

    readyEnvironment();
    for (const body of [
      { action: "start_trial", expectedStopId: "stop-current", workersSuspendedConfirmed: true },
      { action: "start_trial", reason: "missing attestation", expectedStopId: "stop-current" },
      { action: "start_trial", reason: "missing stop id", workersSuspendedConfirmed: true },
    ]) {
      response = await POST(post(body));
      assert.equal(response.status, 400, "reason, attestation, and current stop ID are required");
    }

    for (const extra of [
      { durationMs: 60_000 },
      { expiresAt: "2026-09-11T12:30:00.000Z" },
      { maxAdmissions: 3 },
      { scope: "not-a-scope" },
      { scope: null },
    ]) {
      response = await POST(post({
        action: "start_trial",
        reason: "custom duration must be rejected",
        expectedStopId: "stop-current",
        workersSuspendedConfirmed: true,
        ...extra,
      }));
      assert.equal(response.status, 400, "custom trial timing/budget must be rejected");
    }
    assert.equal(startCalls.length, 0, "invalid payloads must not invoke the repository");

    response = await POST(post({
      action: "start_trial",
      reason: "approved callback trial",
      expectedStopId: "stop-current",
      workersSuspendedConfirmed: true,
    }));
    assert.equal(response.status, 200, "valid staged start should succeed");
    assert.equal(startCalls.length, 1);
    assert.deepEqual(startCalls[0], {
      changedBy: "operator@example.com",
      reason: "approved callback trial",
      expectedStopId: "stop-current",
    }, "the API must pass only fixed-duration repository arguments");
    assert.equal(
      (await responseBody(response)).state.canary.scope,
      "callbacks",
      "omitting scope must preserve callback-only compatibility",
    );
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].action, "protractor_timed_trial_started");
    assert.equal(alertCalls.length, 0, "starting a trial must not send emergency-stop alert");

    response = await POST(post({
      action: "start_trial",
      scope: "callbacks_and_interactive",
      reason: "approved broad trial",
      expectedStopId: "stop-current",
      workersSuspendedConfirmed: true,
    }));
    assert.equal(response.status, 200, "the explicit broad scope should be accepted");
    assert.deepEqual(startCalls[1], {
      changedBy: "operator@example.com",
      reason: "approved broad trial",
      expectedStopId: "stop-current",
      scope: "callbacks_and_interactive",
    });
    assert.equal(
      (await responseBody(response)).state.canary.requiresCallback,
      false,
    );
    assert.equal(auditCalls.length, 2);
    assert.equal(
      auditCalls[1].details.canary.scope,
      "callbacks_and_interactive",
      "the existing full-state audit must retain the selected scope",
    );

    startError = new Error("operator stop changed; refresh state before starting trial");
    response = await POST(post({
      action: "start_trial",
      reason: "stale stop race",
      expectedStopId: "stop-current",
      workersSuspendedConfirmed: true,
    }));
    assert.equal(response.status, 409, "stale current stop ID must be a conflict");
    assert.equal(auditCalls.length, 2, "stale mutation must not be audited as successful");

    currentState = state({ active: false });
    const getResponse = await GET(new NextRequest(
      "http://localhost/api/platform-admin/protractor-operator-stop",
    ));
    const getBody = await responseBody(getResponse);
    assert.equal(getResponse.status, 200);
    assert.equal(getBody.ok, true);
    assert.equal(getBody.trialReady, true);
    assert.equal(getBody.trialUnavailableReason, null);
    assert.deepEqual(getBody.state, currentState);

    process.env.PROTRACTOR_OUTBOUND_DISABLED = "true";
    const unavailableResponse = await GET(new NextRequest(
      "http://localhost/api/platform-admin/protractor-operator-stop",
    ));
    const unavailableBody = await responseBody(unavailableResponse);
    assert.equal(unavailableBody.trialReady, false);
    assert.equal(
      unavailableBody.trialUnavailableReason,
      "Protractor outbound policy denied: service_disabled",
    );

    console.log("All Protractor timed-trial API offline checks passed");
  } finally {
    Object.assign(deps, originalDeps);
    for (const key of ENV_KEYS) {
      const value = originalEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});