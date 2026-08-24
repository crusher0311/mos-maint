// Task #991 — Auto DVI: dashboard-session counterpart of
// /api/extension/auto-dvi/generate, used by the vehicle plan page.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { composeAutoDvi } from "@/lib/auto-dvi/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMPOSE_TIMEOUT_MS = 30_000;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const shopId = Number(session.shopId);
  const isPlatformAdmin = session.role === "platform_admin";
  const denied = await checkShopFeatureGate(shopId, ["auto_dvi"], {
    isPlatformAdmin,
    featureLabel: "Auto DVI",
  });
  if (denied) return denied;

  let body: { vin?: string; mileage?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
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
