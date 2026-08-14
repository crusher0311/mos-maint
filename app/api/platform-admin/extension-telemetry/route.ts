// Platform-admin read API for extension telemetry (Task #1112).
//
// Answers "what happened at shop X yesterday": recent raw events
// (filterable by shop / event / time range) plus a per-shop rollup
// (error counts, slow-call counts, p95 duration). All reads go through
// the extension-telemetry repository — no direct Mongo access here.
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  listRecentTelemetryEvents,
  getTelemetryShopRollup,
  listTelemetryEventNames,
} from "@/lib/data/repositories/extension-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Route-level guard — the /platform-admin page guard is NOT enough
  // (page guard ≠ route guard).
  if (!session.isPlatformAdmin && session.role !== "platform_admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const sp = request.nextUrl.searchParams;
    const hoursRaw = parseInt(sp.get("hours") || "24", 10);
    const hours = Number.isFinite(hoursRaw) ? Math.min(Math.max(hoursRaw, 1), 720) : 24;
    const shopIdRaw = parseInt(sp.get("shopId") || "", 10);
    const shopId = Number.isFinite(shopIdRaw) ? shopIdRaw : null;
    const event = (sp.get("event") || "").trim() || null;
    const limitRaw = parseInt(sp.get("limit") || "200", 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;

    const filters = { shopId, event, hours, limit };
    const [events, rollup, eventNames] = await Promise.all([
      listRecentTelemetryEvents(filters),
      getTelemetryShopRollup(filters),
      listTelemetryEventNames(hours),
    ]);

    return NextResponse.json({
      ok: true,
      filters: { shopId, event, hours, limit },
      events,
      rollup,
      eventNames,
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Extension Telemetry Admin] Error:", err?.message || err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
