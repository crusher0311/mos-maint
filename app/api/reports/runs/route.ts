import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ReportDefinitionError } from "@/lib/report-definition-compiler";
import { lookupReportRun, requestReportRun } from "@/lib/report-run-service";
import { ReportingScopeError } from "@/lib/reporting-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    if (body.lookupOnly === true) {
      const run = await lookupReportRun(session as any, {
        definition: body.definition,
        scope: body.scope,
        reportId: typeof body.reportId === "string" ? body.reportId : undefined,
        reportVersion: Number.isSafeInteger(body.reportVersion) ? body.reportVersion : undefined,
      });
      return NextResponse.json({
        ok: true,
        runId: run?._id,
        status: run?.status || "idle",
        stage: run?.stage,
        result: run?.result,
        generatedAt: run?.generatedAt,
      });
    }
    const response = await requestReportRun(session as any, {
      definition: body.definition,
      scope: body.scope,
      reportId: typeof body.reportId === "string" ? body.reportId : undefined,
      reportVersion: Number.isSafeInteger(body.reportVersion) ? body.reportVersion : undefined,
      force: body.force === true,
      refreshEnabled: body.refreshEnabled === true,
    });
    return NextResponse.json({
      ok: true,
      runId: response.run._id,
      status: response.run.status,
      stage: response.run.stage,
      cache: response.cache,
      deduplicated: response.deduplicated,
      result: response.run.result,
      generatedAt: response.run.generatedAt,
    }, { status: response.run.status === "succeeded" ? 200 : 202 });
  } catch (error) {
    if (error instanceof ReportingScopeError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ReportDefinitionError) return NextResponse.json({ error: error.message, field: error.field }, { status: 400 });
    const message = error instanceof Error ? error.message : "Report could not be queued";
    return NextResponse.json({ error: message }, { status: /Forbidden/.test(message) ? 403 : /not found/i.test(message) ? 404 : 400 });
  }
}