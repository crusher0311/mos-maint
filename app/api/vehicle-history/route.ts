import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readEnterpriseVehicleHistory } from "@/lib/vehicle-history/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie, Authorization" };

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  try {
    const result = await readEnterpriseVehicleHistory({
      currentShopId: Number(session.shopId), email: session.email,
      channel: "dashboard", verified: true,
    }, req.nextUrl.searchParams.get("vin"));
    return NextResponse.json(result, { headers });
  } catch {
    return NextResponse.json({ error: "Shared history is unavailable. No cross-location data was returned." }, { status: 503, headers });
  }
}
