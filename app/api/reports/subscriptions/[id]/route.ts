import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveReportingScope, ReportingScopeError } from "@/lib/reporting-scope";
import {
  deleteReportingSubscription,
  findReportingSubscription,
  updateReportingSubscription,
} from "@/lib/data/repositories/reporting-subscriptions";
import { nextReportingRun, validateRecipientScope, validateReportingSubscription } from "@/lib/reporting-delivery";

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
    const merged = validateReportingSubscription({ ...auth.doc, ...body, scope: body.scope || auth.doc!.scope, filters: body.filters === undefined ? auth.doc!.filters : body.filters });
    const request = { kind: merged.scope.kind, shopId: merged.scope.shopId?.toString(), enterpriseId: merged.scope.enterpriseId };
    const actorScope = await resolveReportingScope(auth.session!, request);
    const { scope: recipientScope } = await validateRecipientScope(merged.recipientEmail, merged.scope);
    if (merged.filters?.locationId && (!actorScope.shopIds.includes(merged.filters.locationId) || !recipientScope.shopIds.includes(merged.filters.locationId))) {
      return NextResponse.json({ error: "Filtered location is outside actor or recipient access" }, { status: 403 });
    }
    const updated = await updateReportingSubscription(id, {
      ...merged, nextRunAt: nextReportingRun(merged), paused: Boolean(merged.paused),
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