import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getReportingKpis, normalizeReportingRange } from "@/lib/reporting-kpi-service";
import { ReportingScopeError, resolveReportingScope } from "@/lib/reporting-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const p = req.nextUrl.searchParams;
    const scope = await resolveReportingScope(session, {
      kind: p.get("scope"), shopId: p.get("shopId"), enterpriseId: p.get("enterpriseId"),
    });
    const range = normalizeReportingRange(p.get("startDate"), p.get("endDate"));
    return NextResponse.json(await getReportingKpis(scope, range));
  } catch (error) {
    if (error instanceof ReportingScopeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Failed to build KPI report";
    const status = message.startsWith("Invalid date") || message.startsWith("Date range") ? 400 : 500;
    console.error("[reporting-kpis]", error);
    return NextResponse.json({ error: status === 500 ? "Failed to build KPI report" : message }, { status });
  }
}
