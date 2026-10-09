import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { readEnterpriseVehicleHistory } from "@/lib/vehicle-history/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Authorization",
};
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers });
}
export async function GET(req: NextRequest) {
  try {
    const guard = await guardExtensionShopRequest(req, {
      smsShopId: req.nextUrl.searchParams.get("shopId"),
      provider: req.nextUrl.searchParams.get("provider"),
      requiredFeatures: ["maintenance"], requiredCapabilities: ["read"], corsHeaders: headers,
    });
    if (!guard.ok) return guard.response;
    const view = await readEnterpriseVehicleHistory({
      currentShopId: guard.mosShopId, email: guard.user.email ?? "",
      channel: "extension", verified: guard.principal.assurance === "verified",
    }, req.nextUrl.searchParams.get("vin"));
    return NextResponse.json(view, { headers });
  } catch {
    return NextResponse.json({ error: "Shared history is unavailable. No cross-location data was returned." }, { status: 503, headers });
  }
}
