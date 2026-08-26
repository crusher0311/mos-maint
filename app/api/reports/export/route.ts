import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { logAdminAction } from "@/lib/data/repositories/audit-logs";
import { getReportingKpis, normalizeReportingRange, ReportingQueryError } from "@/lib/reporting-kpi-service";
import { ReportingScopeError, resolveReportingScope } from "@/lib/reporting-scope";
import { reportingCsv } from "@/lib/reporting-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const p = req.nextUrl.searchParams;
    let scope = await resolveReportingScope(session, {
      kind: p.get("scope"), shopId: p.get("shopId"), enterpriseId: p.get("enterpriseId"),
    });
    const locationId = p.get("locationId") ? Number(p.get("locationId")) : undefined;
    if (locationId != null) {
      if (!Number.isSafeInteger(locationId) || !scope.shopIds.includes(locationId)) {
        return NextResponse.json({ error: "Location filter is outside authorized scope" }, { status: 403 });
      }
      scope = { ...scope, kind: "shop", shopIds: [locationId], shops: scope.shops.filter((s) => s.shopId === locationId) };
    }
    const range = normalizeReportingRange(p.get("startDate"), p.get("endDate"));
    const filters = {
      ...(locationId ? { locationId } : {}),
      ...(p.get("advisor") ? { advisorKey: p.get("advisor")! } : {}),
      ...(p.get("technician") ? { technicianKey: p.get("technician")! } : {}),
    };
    const csv = reportingCsv(await getReportingKpis(scope, range), filters);
    await logAdminAction({
      action: "data_export", adminEmail: session.email, targetShopId: scope.shopIds.length === 1 ? scope.shopIds[0] : undefined,
      details: { report: "reporting_kpis", scope: scope.kind, shopIds: scope.shopIds, start: range.start, end: range.end, filters, bytes: Buffer.byteLength(csv) },
    });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="reporting-${range.start.toISOString().slice(0,10)}-${range.end.toISOString().slice(0,10)}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof ReportingScopeError) {
      return NextResponse.json(
        { error: error.message, kind: error.status === 401 || error.status === 403 ? "authorization" : "validation", retryable: false },
        { status: error.status },
      );
    }
    if (error instanceof ReportingQueryError) {
      return NextResponse.json({ error: error.message, kind: error.kind, retryable: true }, { status: error.kind === "deadline" ? 504 : 503 });
    }
    const message = error instanceof Error ? error.message : "Export failed";
    const clientError = /^(Invalid date|Date range|Choose either|Selected advisor|Selected technician)/.test(message);
    return NextResponse.json(
      { error: clientError ? message : "Export failed", kind: clientError ? "validation" : "database", retryable: !clientError },
      { status: clientError ? 400 : 500 },
    );
  }
}