// Task #991 — Auto DVI: dashboard-session counterpart of
// /api/extension/auto-dvi/generate, used by the vehicle plan page.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { composeAutoDvi } from "@/lib/auto-dvi/service";
import { visitAssistanceContext, suggestionId } from "@/lib/auto-dvi/staff/assistance-context";
import { dispatchFailure } from "@/lib/shop-dispatch/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMPOSE_TIMEOUT_MS = 30_000;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const shopId = Number(session.shopId);
  let body: { vin?: string; mileage?: number; visitId?: string; revision?: number };
  try { body = await req.json(); } catch { return NextResponse.json({error: "Invalid JSON body"}, {status: 400}); }
  if (body.visitId !== undefined) {
    try {
      const context = await visitAssistanceContext(body.visitId, body.revision);
      const vehicle = await context.vehicle();
      const result = await withUpstreamTimeout(composeAutoDvi({shopId: context.shopId, ...vehicle}),
        COMPOSE_TIMEOUT_MS, "visit-dvi-compose", {ok: false as const, error: "Suggestion build timed out"});
      if (!result.ok) return NextResponse.json({error: result.error}, {status: 502});
      await context.revalidate();
      return NextResponse.json({ok: true, visitId: context.visitId, revision: context.revision,
        items: result.items.map(item => ({id: suggestionId(item.source, item.id), name: item.name.slice(0, 160),
          source: item.source, reference: item.id.slice(0, 120),
          context: item.notes ?? item.bucket ?? "Suggested scope only"})), hidden: result.hidden});
    } catch (cause) { return dispatchFailure(cause); }
  }
  const isPlatformAdmin = session.role === "platform_admin";
  const denied = await checkShopFeatureGate(shopId, ["maintenance", "auto_dvi"], {
    isPlatformAdmin: isPlatformAdmin && !session.isImpersonation,
    featureLabel: "Auto DVI",
  });
  if (denied) return denied;

  if (!body.vin) {
    return NextResponse.json({ error: "vin is required" }, { status: 400 });
  }

  const result = await withUpstreamTimeout(
    composeAutoDvi({
      shopId,
      vin: body.vin,
      mileage: typeof body.mileage === "number" ? body.mileage : null,
    }),
    COMPOSE_TIMEOUT_MS,
    "auto-dvi-compose-dashboard",
    { ok: false as const, error: "Inspection build timed out — please try again" },
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json(result);
}
