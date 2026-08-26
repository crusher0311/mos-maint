import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { executeReportDefinition, ReportDefinitionError } from "@/lib/report-definition-compiler";
import { ReportingQueryError } from "@/lib/reporting-kpi-service";
import { ReportingScopeError, resolveReportingScope } from "@/lib/reporting-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    const requested = body.scope && typeof body.scope === "object" ? body.scope as Record<string, unknown> : {};
    const scope = await resolveReportingScope(session, {
      kind: typeof requested.kind === "string" ? requested.kind : null,
      shopId: requested.shopId == null ? null : String(requested.shopId),
      enterpriseId: typeof requested.enterpriseId === "string" ? requested.enterpriseId : null,
    });
    const result = await executeReportDefinition(body.definition, scope);
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof ReportingScopeError) {
      return NextResponse.json({ error: error.message, kind: "authorization", retryable: false }, { status: error.status });
    }
    if (error instanceof ReportDefinitionError) {
      return NextResponse.json({ error: error.message, field: error.field, kind: "validation", retryable: false }, { status: 400 });
    }
    if (error instanceof ReportingQueryError) {
      return NextResponse.json({ error: error.message, kind: error.kind, retryable: true, stage: error.stage }, { status: error.kind === "deadline" ? 504 : 503 });
    }
    console.error("[custom-report-preview] failed", error);
    return NextResponse.json({ error: "Report preview could not be generated", kind: "database", retryable: true }, { status: 500 });
  }
}