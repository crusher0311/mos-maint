import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveReportingScope, ReportingScopeError } from "@/lib/reporting-scope";
import {
  createReportingSubscription,
  listReportingSubscriptions,
} from "@/lib/data/repositories/reporting-subscriptions";
import {
  createDisableToken,
  hashDisableToken,
  nextReportingRun,
  validateRecipientScope,
  validateReportingSubscription,
} from "@/lib/reporting-delivery";

const allowed = (session: NonNullable<Awaited<ReturnType<typeof getSession>>>) =>
  Boolean(session.isPlatformAdmin || session.role === "platform_admin" || session.role === "owner" || session.role === "admin");

const output = (doc: any) => {
  const { disableToken, disableTokenHash, processingKey, processingAt, ...safe } = doc;
  return safe;
};

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!allowed(session)) return NextResponse.json({ error: "Owner or admin access required" }, { status: 403 });
  const docs = await listReportingSubscriptions(session.email, Boolean(session.isPlatformAdmin || session.role === "platform_admin"));
  return NextResponse.json({ ok: true, subscriptions: docs.map(output) });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!allowed(session)) return NextResponse.json({ error: "Owner or admin access required" }, { status: 403 });
  try {
    const input = validateReportingSubscription(await req.json());
    const request = { kind: input.scope.kind, shopId: input.scope.shopId?.toString(), enterpriseId: input.scope.enterpriseId };
    const actorScope = await resolveReportingScope(session, request);
    const { scope: recipientScope } = await validateRecipientScope(input.recipientEmail, input.scope);
    if (input.filters?.locationId && (!actorScope.shopIds.includes(input.filters.locationId) || !recipientScope.shopIds.includes(input.filters.locationId))) {
      return NextResponse.json({ error: "Filtered location is outside actor or recipient access" }, { status: 403 });
    }
    const token = createDisableToken();
    const now = new Date();
    const doc = await createReportingSubscription({
      ...input, createdBy: session.email.toLowerCase(), paused: Boolean(input.paused),
      disableToken: token, disableTokenHash: hashDisableToken(token),
      nextRunAt: nextReportingRun(input, now), deliveryHistory: [], createdAt: now, updatedAt: now,
    });
    return NextResponse.json({ ok: true, subscription: output(doc) }, { status: 201 });
  } catch (error) {
    if (error instanceof ReportingScopeError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid subscription" }, { status: 400 });
  }
}