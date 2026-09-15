import { NextRequest, NextResponse } from "next/server";
import { deps } from "./deps";
import { evaluateProtractorOutboundPolicy } from "@/lib/integrations/protractor/outbound-policy.cjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PRODUCTION_SERVICE_ID = "srv-d55jaqkhg0os73a5dd8g";

function isProductionService(): boolean {
  return process.env.RENDER_SERVICE_ID === PRODUCTION_SERVICE_ID;
}

function trialConfigReadiness(): {
  trialReady: boolean;
  trialUnavailableReason: string | null;
} {
  if (process.env.PROTRACTOR_CALLBACK_TRIAL_ENABLED !== "true") {
    return {
      trialReady: false,
      trialUnavailableReason: "callback trial feature is not enabled",
    };
  }
  const outboundPolicy = evaluateProtractorOutboundPolicy(process.env);
  if (!outboundPolicy.allowed) {
    return {
      trialReady: false,
      trialUnavailableReason: `Protractor outbound policy denied: ${outboundPolicy.reason}`,
    };
  }
  if (
    outboundPolicy.callbackOnly !== true ||
    outboundPolicy.requireTimedTrial !== true
  ) {
    return {
      trialReady: false,
      trialUnavailableReason: "Protractor outbound policy is not callback-only timed-trial mode",
    };
  }
  if (process.env.PROTRACTOR_OUTBOUND_DISABLED !== "false") {
    return {
      trialReady: false,
      trialUnavailableReason: "Protractor outbound traffic is not explicitly enabled",
    };
  }
  if (process.env.PROTRACTOR_RELAY_REQUIRED !== "true") {
    return {
      trialReady: false,
      trialUnavailableReason: "Protractor relay is not required",
    };
  }
  if (process.env.PROTRACTOR_RELAY_MODE !== "relay") {
    return {
      trialReady: false,
      trialUnavailableReason: "Protractor relay mode is not enabled",
    };
  }
  return { trialReady: true, trialUnavailableReason: null };
}

async function sessionOperator(): Promise<string | null> {
  try {
    return (await deps.requirePlatformAdmin()).email;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!(await sessionOperator())) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    state: await deps.getProtractorOperatorStop(),
    ...trialConfigReadiness(),
    // Continuous activation uses the same deliberately restrictive staging
    // prerequisites. Keep the timed fields for existing clients.
    liveReady: trialConfigReadiness().trialReady,
    liveUnavailableReason: trialConfigReadiness().trialUnavailableReason,
  });
}

export async function POST(req: NextRequest) {
  const operator = await sessionOperator();
  if (!operator) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!isProductionService()) {
    return NextResponse.json(
      { ok: false, error: "Protractor operator stop mutations are production-only" },
      { status: 403 },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const action =
    body && typeof body === "object" && "action" in body ? (body as { action?: unknown }).action : null;
  const reason =
    body && typeof body === "object" && "reason" in body && typeof (body as { reason?: unknown }).reason === "string"
      ? (body as { reason: string }).reason
      : undefined;
  const expectedStopId =
    body && typeof body === "object" && "expectedStopId" in body &&
      typeof (body as { expectedStopId?: unknown }).expectedStopId === "string"
      ? (body as { expectedStopId: string }).expectedStopId
      : undefined;
  const expiresAtRaw =
    body && typeof body === "object" && "expiresAt" in body &&
      typeof (body as { expiresAt?: unknown }).expiresAt === "string"
      ? (body as { expiresAt: string }).expiresAt
      : undefined;
  const maxAdmissions =
    body && typeof body === "object" && "maxAdmissions" in body
      ? (body as { maxAdmissions?: unknown }).maxAdmissions
      : undefined;
  const workersSuspendedConfirmed =
    body && typeof body === "object" && "workersSuspendedConfirmed" in body
      ? (body as { workersSuspendedConfirmed?: unknown }).workersSuspendedConfirmed
      : undefined;
  const scope =
    body && typeof body === "object" && "scope" in body
      ? (body as { scope?: unknown }).scope
      : undefined;
  const requestedScope =
    scope === "callbacks" || scope === "callbacks_and_interactive"
      ? scope
      : undefined;
  if (action !== "activate" && action !== "clear" && action !== "start_trial" && action !== "start_live") {
    return NextResponse.json(
      { ok: false, error: "action must be activate, clear, start_trial, or start_live" },
      { status: 400 },
    );
  }
  if (
    action === "start_trial" &&
    scope !== undefined &&
    scope !== "callbacks" &&
    scope !== "callbacks_and_interactive"
  ) {
    return NextResponse.json(
      { ok: false, error: "scope must be callbacks or callbacks_and_interactive" },
      { status: 400 },
    );
  }
  if ((action === "activate" || action === "start_trial" || action === "start_live") && !reason?.trim()) {
    return NextResponse.json({ ok: false, error: "reason is required when activating" }, { status: 400 });
  }
  if ((action === "start_trial" || action === "start_live") && (
    !expectedStopId?.trim() ||
    workersSuspendedConfirmed !== true
  )) {
    return NextResponse.json(
      {
        ok: false,
        error: `reason, expectedStopId, and workersSuspendedConfirmed=true are required when starting ${
          action === "start_live" ? "continuous live mode" : "a timed trial"
        }`,
      },
      { status: 400 },
    );
  }
  if (action === "start_trial" && (
    body && typeof body === "object" && (
      "expiresAt" in body ||
      "maxAdmissions" in body ||
      "duration" in body ||
      "durationMs" in body ||
      "durationMinutes" in body ||
      "expiresInMs" in body
    )
  )) {
    return NextResponse.json(
      { ok: false, error: "timed trial duration, expiry, and maxAdmissions are fixed server-side" },
      { status: 400 },
    );
  }
  if (action === "start_live" && (
    body && typeof body === "object" && (
      "expiresAt" in body ||
      "maxAdmissions" in body ||
      "duration" in body ||
      "durationMs" in body ||
      "durationMinutes" in body ||
      "expiresInMs" in body ||
      "scope" in body
    )
  )) {
    return NextResponse.json(
      { ok: false, error: "continuous live mode has a fixed callback + authenticated-interactive scope and no duration or cap input" },
      { status: 400 },
    );
  }
  if (action === "start_trial" && !trialConfigReadiness().trialReady) {
    return NextResponse.json(
      { ok: false, error: trialConfigReadiness().trialUnavailableReason },
      { status: 409 },
    );
  }
  if (action === "start_live" && !trialConfigReadiness().trialReady) {
    return NextResponse.json(
      { ok: false, error: trialConfigReadiness().trialUnavailableReason },
      { status: 409 },
    );
  }
  if (action === "clear" && (
    !reason?.trim() || !expectedStopId?.trim() || !expiresAtRaw ||
    !Number.isInteger(maxAdmissions)
  )) {
    return NextResponse.json(
      { ok: false, error: "reason, expectedStopId, expiresAt, and maxAdmissions are required when clearing" },
      { status: 400 },
    );
  }

  let state;
  try {
    state = action === "activate"
      ? await deps.activateProtractorOperatorStop({ changedBy: operator, reason: reason! })
      : action === "start_trial"
        ? await deps.startProtractorTimedTrial({
            changedBy: operator,
            reason: reason!,
            expectedStopId: expectedStopId!,
            requiresRelay: true,
             ...(requestedScope !== undefined ? { scope: requestedScope } : {}),
          })
        : action === "start_live"
          ? await deps.startProtractorLive({
              changedBy: operator,
              reason: reason!,
              expectedStopId: expectedStopId!,
              workersSuspendedConfirmed: true,
            })
      : await deps.clearProtractorOperatorStop({
          changedBy: operator,
          reason: reason!,
          expectedStopId: expectedStopId!,
          expiresAt: new Date(expiresAtRaw!),
          maxAdmissions: maxAdmissions as number,
        });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Operator stop update failed";
    const status = /operator stop changed/.test(message)
      ? 409
      : /expiresAt|maxAdmissions|required/.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
  await deps.logAdminAction({
    action: action === "activate"
      ? "protractor_operator_stop_activated"
      : action === "start_trial"
        ? "protractor_timed_trial_started"
        : action === "start_live"
          ? "protractor_continuous_live_started"
        : "protractor_operator_stop_cleared",
    adminEmail: operator,
    details: {
      reason: reason?.trim(),
      via: "platform_admin_session",
      state,
      canary: state.canary,
      ...((action === "start_trial" || action === "start_live") ? { workersSuspendedConfirmed: true } : {}),
    },
    ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || undefined,
    userAgent: req.headers.get("user-agent") || undefined,
  }).catch(error => {
    console.error("[ProtractorOperatorStop] Audit write failed:", error);
  });
  if (action === "activate") {
    await deps.sendOpsAlert({
      title: "Protractor operator emergency stop activated",
      severity: "critical",
      summary: "An operator blocked all new physical Protractor admissions without suspending MOS.",
      fields: {
        reason: reason!.trim(),
        stopId: state.stopId || "unknown",
        physicalAdmissionInFlight: state.physicalAdmissionInFlight,
      },
      source: "protractor-operator-stop",
      dedupKey: `protractor-operator-stop:${state.stopId || "unknown"}`,
    }).catch(error => {
      console.error("[ProtractorOperatorStop] Alert delivery failed:", error);
    });
  }
  return NextResponse.json({ ok: true, state });
}