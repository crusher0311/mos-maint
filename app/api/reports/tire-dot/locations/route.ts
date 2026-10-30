import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { tireLocations, TireDotError } from "@/lib/tire-dot-report-service";
import { ReportingScopeError } from "@/lib/reporting-scope";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const session = await getSession();
  const headers = { "Cache-Control": "private, no-store" };
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  try {
    const p = req.nextUrl.searchParams;
    const { locations } = await tireLocations(session, { kind: p.get("scope"), shopId: p.get("shopId"), enterpriseId: p.get("enterpriseId") });
    return NextResponse.json({ locations }, { headers });
  } catch (e) {
    return NextResponse.json({ error: "Unable to load authorized Tekmetric locations" }, { status: e instanceof TireDotError || e instanceof ReportingScopeError ? e.status : 503, headers });
  }
}
