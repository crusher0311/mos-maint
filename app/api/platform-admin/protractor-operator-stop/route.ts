import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { logAdminAction } from "@/lib/audit-log";
import { sendOpsAlert } from "@/lib/alerts/notify";
import {
  activateProtractorOperatorStop,
  clearProtractorOperatorStop,
  getProtractorOperatorStop,
} from "@/lib/data/repositories/api-usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PRODUCTION_SERVICE_ID = "srv-d55jaqkhg0os73a5dd8g";

function isProductionService(): boolean {
  return process.env.RENDER_SERVICE_ID === PRODUCTION_SERVICE_ID;
}

async function sessionOperator(): Promise<string | null> {
  try {
    return (await requirePlatformAdmin()).email;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if (!(await sessionOperator())) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, state: await getProtractorOperatorStop() });
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
  if (action !== "activate" && action !== "clear") {
    return NextResponse.json({ ok: false, error: "action must be activate or clear" }, { status: 400 });
  }
  if (action === "activate" && !reason?.trim()) {
    return NextResponse.json({ ok: false, error: "reason is required when activating" }, { status: 400 });
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
      ? await activateProtractorOperatorStop({ changedBy: operator, reason: reason! })
      : await clearProtractorOperatorStop({
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
  await logAdminAction({
    action: action === "activate" ? "protractor_operator_stop_activated" : "protractor_operator_stop_cleared",
    adminEmail: operator,
    details: {
      reason: reason?.trim(),
      via: "platform_admin_session",
      state,
      canary: state.canary,
    },
    ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || undefined,
    userAgent: req.headers.get("user-agent") || undefined,
  }).catch(error => {
    console.error("[ProtractorOperatorStop] Audit write failed:", error);
  });
  if (action === "activate") {
    await sendOpsAlert({
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