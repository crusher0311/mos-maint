import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveReportingScope, ReportingScopeError } from "@/lib/reporting-scope";
import {
  deleteReportingSubscription,
  findReportingSubscription,
  updateReportingSubscription,
} from "@/lib/data/repositories/reporting-subscriptions";
import { canRecipientReadSavedReport, nextReportingRun, resolveSubscriptionReport, validateRecipientScope, validateReportingSubscription } from "@/lib/reporting-delivery";
import { canReadCustomReport } from "@/lib/custom-report-access";

async function authorized(id: string) {
  const session = await getSession();
  if (!session) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!["owner","admin","platform_admin"].includes(session.role || "") && !session.isPlatformAdmin) {
    return { response: NextResponse.json({ error: "Owner or admin access required" }, { status: 403 }) };
  }
  const doc = await findReportingSubscription(id);
  if (!doc) return { response: NextResponse.json({ error: "Subscription not found" }, { status: 404 }) };
  if (!session.isPlatformAdmin && session.role !== "platform_admin" && doc.createdBy !== session.email.toLowerCase()) {
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session, doc };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorized(id);
  if (auth.response) return auth.response;
  try {
    const body = await req.json();
    const reportChanged = body.reportId !== undefined && body.reportId !== auth.doc!.reportId;
    const merged = validateReportingSubscription({
      ...auth.doc,
      ...body,
      ...(reportChanged && body.reportVersion === undefined ? { reportVersion: undefined } : {}),
      scope: body.scope || auth.doc!.scope,
      filters: body.filters === undefined ? auth.doc!.filters : body.filters,
    });
    const savedReport = await resolveSubscriptionReport(merged);
    const request = { kind: merged.scope.kind, shopId: merged.scope.shopId?.toString(), enterpriseId: merged.scope.enterpriseId };
    const actorScope = await resolveReportingScope(auth.session!, request);
    if (savedReport && !canReadCustomReport({
      email: auth.session!.email,
      isPlatformAdmin: Boolean(auth.session!.isPlatformAdmin || auth.session!.role === "platform_admin"),
    }, savedReport.raw as any, actorScope)) {
      return NextResponse.json({ error: "You do not have access to this saved report" }, { status: 403 });
    }
    const { user: recipient, scope: recipientScope } = await validateRecipientScope(merged.recipientEmail, merged.scope);
    if (savedReport && !canRecipientReadSavedReport(recipient, savedReport, recipientScope)) {
      return NextResponse.json({ error: "Recipient does not have access to this saved report" }, { status: 403 });
    }
    if (merged.filters?.locationId && (!actorScope.shopIds.includes(merged.filters.locationId) || !recipientScope.shopIds.includes(merged.filters.locationId))) {
      return NextResponse.json({ error: "Filtered location is outside actor or recipient access" }, { status: 403 });
    }
    const updated = await updateReportingSubscription(id, {
      ...merged,
      ...(savedReport ? { reportVersion: savedReport.version } : {}),
      nextRunAt: nextReportingRun(merged), paused: Boolean(merged.paused),
    });
    if (!updated) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
    const { disableToken, disableTokenHash, processingKey, processingAt, ...safe } = updated;
    return NextResponse.json({ ok: true, subscription: safe });
  } catch (error) {
    if (error instanceof ReportingScopeError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid subscription" }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorized(id);
  if (auth.response) return auth.response;
  await deleteReportingSubscription(id);
  return NextResponse.json({ ok: true });
}