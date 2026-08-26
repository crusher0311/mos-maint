import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getReportingPeriods, normalizeReportingRange, ReportingQueryError } from "@/lib/reporting-kpi-service";
import { ReportingScopeError, resolveReportingScope } from "@/lib/reporting-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const startedAt = Date.now();
    const p = req.nextUrl.searchParams;
    const scopeStartedAt = Date.now();
    const scope = await resolveReportingScope(session, {
      kind: p.get("scope"), shopId: p.get("shopId"), enterpriseId: p.get("enterpriseId"),
    });
    console.info("[reporting-kpis] stage_complete", { stage: "scope", durationMs: Date.now() - scopeStartedAt, shops: scope.shopIds.length });
    const range = normalizeReportingRange(p.get("startDate"), p.get("endDate"));
    const comparisonRange = p.get("comparisonStartDate") && p.get("comparisonEndDate")
      ? normalizeReportingRange(p.get("comparisonStartDate"), p.get("comparisonEndDate"))
      : null;
    const result = await getReportingPeriods(scope, range, comparisonRange);
    console.info("[reporting-kpis] request_complete", { durationMs: Date.now() - startedAt, comparison: Boolean(comparisonRange) });
    return NextResponse.json(comparisonRange ? result : result.current);
  } catch (error) {
    if (error instanceof ReportingScopeError) {
      return NextResponse.json(
        { error: error.message, kind: error.status === 401 || error.status === 403 ? "authorization" : "validation", retryable: false },
        { status: error.status },
      );
    }
    if (error instanceof ReportingQueryError) {
      return NextResponse.json(
        { error: error.message, kind: error.kind, retryable: true, stage: error.stage },
        { status: error.kind === "deadline" ? 504 : 503 },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to build KPI report";
    const status = message.startsWith("Invalid date") || message.startsWith("Date range") ? 400 : 500;
    console.error("[reporting-kpis]", error);
    return NextResponse.json(
      { error: status === 500 ? "Failed to build KPI report" : message, kind: status === 500 ? "database" : "validation", retryable: status === 500 },
      { status },
    );
  }
}
