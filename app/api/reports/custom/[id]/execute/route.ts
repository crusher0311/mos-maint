import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { canReadCustomReport } from "@/lib/custom-report-access";
import { scopeRequest } from "@/lib/custom-report-api";
import {
  currentCustomReportDefinition,
  findCustomReport,
} from "@/lib/data/repositories/custom-reports";
import { ReportingQueryError } from "@/lib/reporting-kpi-service";
import { ReportingScopeError, resolveReportingScope } from "@/lib/reporting-scope";
import { executeReportDefinition, ReportDefinitionError } from "@/lib/report-definition-compiler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const report = await findCustomReport((await params).id);
    if (!report) return NextResponse.json({ error: "Report not found" }, { status: 404 });

    // Never persist resolved shop IDs. Resolve the saved scope on every run so
    // enterprise membership and the actor's assignments cannot become stale.
    const scope = await resolveReportingScope(session, scopeRequest(report.scope));
    if (!canReadCustomReport({
      email: session.email,
      isPlatformAdmin: Boolean(session.isPlatformAdmin || session.role === "platform_admin"),
    }, report, scope)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const version = currentCustomReportDefinition(report);
    if (!version) return NextResponse.json({ error: "Report definition is missing" }, { status: 500 });
    await req.json().catch(() => ({}));
    const result = await executeReportDefinition(version.definition, scope);
    return NextResponse.json({
      ok: true,
      report: { id: report._id.toString(), name: report.name, version: version.version },
      definition: version.definition,
      result,
    });
  } catch (error) {
    if (error instanceof ReportingScopeError) {
      return NextResponse.json({ error: error.message, kind: "authorization", retryable: false }, { status: error.status });
    }
    if (error instanceof ReportingQueryError) {
      return NextResponse.json(
        { error: error.message, kind: error.kind, retryable: true, stage: error.stage },
        { status: error.kind === "deadline" ? 504 : 503 },
      );
    }
    if (error instanceof ReportDefinitionError) {
      return NextResponse.json(
        { error: error.message, kind: "validation", retryable: false, field: error.field },
        { status: 400 },
      );
    }
    const message = error instanceof Error ? error.message : "Failed to execute report";
    const validation = message.startsWith("Invalid date") || message.startsWith("Date range");
    return NextResponse.json(
      { error: validation ? message : "Failed to execute report", kind: validation ? "validation" : "database", retryable: !validation },
      { status: validation ? 400 : 500 },
    );
  }
}