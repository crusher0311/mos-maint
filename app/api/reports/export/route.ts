import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { logAdminAction } from "@/lib/data/repositories/audit-logs";
import { getReportingKpis, normalizeReportingRange, ReportingQueryError } from "@/lib/reporting-kpi-service";
import { ReportingScopeError, resolveReportingScope } from "@/lib/reporting-scope";
import { declarativeReportCsv, reportingCsvResult } from "@/lib/reporting-delivery";
import { findSavedReportingDefinition } from "@/lib/data/repositories/saved-reporting-definitions";
import { canReadCustomReport } from "@/lib/custom-report-access";
import { requestReportRun } from "@/lib/report-run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const p = req.nextUrl.searchParams;
    const reportId = p.get("reportId") || p.get("savedReportId") || undefined;
    const rawVersion = p.get("reportVersion") || p.get("savedReportVersion");
    const reportVersion = rawVersion == null ? undefined : Number(rawVersion);
    if (reportVersion != null && (!Number.isSafeInteger(reportVersion) || reportVersion <= 0)) {
      return NextResponse.json({ error: "reportVersion must be a positive integer" }, { status: 400 });
    }
    const savedReport = reportId ? await findSavedReportingDefinition(reportId, reportVersion) : null;
    if (reportId && !savedReport) return NextResponse.json({ error: "Saved report or referenced version not found" }, { status: 404 });
    const scopeRequest = savedReport?.scope ?? {
      kind: p.get("scope"), shopId: p.get("shopId"), enterpriseId: p.get("enterpriseId"),
    };
    let scope = await resolveReportingScope(session, {
      kind: scopeRequest.kind,
      shopId: scopeRequest.shopId == null ? null : String(scopeRequest.shopId),
      enterpriseId: scopeRequest.enterpriseId || null,
    });
    if (savedReport && !canReadCustomReport({
      email: session.email,
      isPlatformAdmin: Boolean(session.isPlatformAdmin || session.role === "platform_admin"),
    }, savedReport.raw as any, scope)) {
      return NextResponse.json({ error: "You do not have access to this saved report" }, { status: 403 });
    }
    if (savedReport) {
      const prepared = await requestReportRun(session as any, {
        reportId: savedReport.reportId,
        reportVersion: savedReport.version,
        refreshEnabled: true,
      });
      if (!prepared.run.result) {
        return NextResponse.json({
          ok: false,
          status: prepared.run.status,
          runId: prepared.run._id,
          error: "This report is still being prepared. Try the export again when the run completes.",
        }, { status: 202 });
      }
      const csv = declarativeReportCsv(prepared.run.result);
      await logAdminAction({
        action: "data_export", adminEmail: session.email,
        targetShopId: scope.shopIds.length === 1 ? scope.shopIds[0] : undefined,
        details: {
          report: savedReport.reportId, reportVersion: savedReport.version,
          scope: scope.kind, shopIds: scope.shopIds,
          rows: prepared.run.result.rows.length, snapshotRunId: prepared.run._id,
          bytes: Buffer.byteLength(csv),
        },
      });
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="reporting-${savedReport.reportId}-v${savedReport.version}.csv"`,
          "Cache-Control": "private, no-store",
        },
      });
    }
    const locationId = p.get("locationId") ? Number(p.get("locationId")) : undefined;
    if (locationId != null) {
      if (!Number.isSafeInteger(locationId) || !scope.shopIds.includes(locationId)) {
        return NextResponse.json({ error: "Location filter is outside authorized scope" }, { status: 403 });
      }
      scope = { ...scope, kind: "shop", shopIds: [locationId], shops: scope.shops.filter((s) => s.shopId === locationId) };
    }
    const range = normalizeReportingRange(
      p.get("startDate"),
      p.get("endDate"),
    );
    const filters = {
      ...(locationId ? { locationId } : {}),
      ...(p.get("advisor") ? { advisorKey: p.get("advisor")! } : {}),
      ...(p.get("technician") ? { technicianKey: p.get("technician")! } : {}),
    };
    const maxRows = p.get("maxRows") == null ? undefined : Number(p.get("maxRows"));
    const result = reportingCsvResult(await getReportingKpis(scope, range), filters, {
      selectedFields: undefined,
      layout: undefined,
      maxRows,
    });
    const csv = result.csv;
    await logAdminAction({
      action: "data_export", adminEmail: session.email, targetShopId: scope.shopIds.length === 1 ? scope.shopIds[0] : undefined,
      details: {
        report: "reporting_kpis",
        reportVersion: undefined,
        scope: scope.kind, shopIds: scope.shopIds, start: range.start, end: range.end, filters,
        selectedFields: result.columns, rows: result.rowCount, truncated: result.truncated,
        rowCap: Math.min(maxRows || 5_000, 5_000), bytes: Buffer.byteLength(csv),
      },
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
    const clientError = /^(Invalid date|Date range|Choose either|Selected advisor|Selected technician|maxRows)/.test(message);
    return NextResponse.json(
      { error: clientError ? message : "Export failed", kind: clientError ? "validation" : "database", retryable: !clientError },
      { status: clientError ? 400 : 500 },
    );
  }
}