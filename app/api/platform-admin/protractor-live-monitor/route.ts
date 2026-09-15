import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getProtractorLiveMonitor } from "@/lib/data/repositories/protractor-live-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The timed-live operator surface is deliberately pinned to the production
// service. A preview must not present an ambiguous mix of preview and fleet
// telemetry as production evidence.
const PRODUCTION_SERVICE_ID = "srv-d55jaqkhg0os73a5dd8g";

function isProductionService(): boolean {
  return process.env.RENDER_SERVICE_ID === PRODUCTION_SERVICE_ID;
}

export async function GET() {
  try {
    await requirePlatformAdmin();
  } catch (error: any) {
    if (error?.digest?.startsWith?.("NEXT_REDIRECT")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isProductionService()) {
    return NextResponse.json(
      { error: "Protractor live monitoring is available only on the production service" },
      { status: 403 },
    );
  }
  try {
    return NextResponse.json(await getProtractorLiveMonitor());
  } catch {
    // The repository normally degrades each source to an explicit error state;
    // retain a safe route-level failure if a programming/configuration error
    // happens before that boundary.
    return NextResponse.json({ error: "Protractor live monitoring is unavailable" }, { status: 503 });
  }
}