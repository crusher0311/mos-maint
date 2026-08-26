import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { canReadCustomReport } from "@/lib/custom-report-access";
import { ReportingScopeError, resolveReportingScope } from "@/lib/reporting-scope";
import {
  createCustomReport,
  listCustomReports,
} from "@/lib/data/repositories/custom-reports";
import {
  customReportJson,
  scopeRequest,
  validateCustomReportDefinition,
  validateCustomReportName,
  validateCustomReportScope,
  validateCustomReportSharing,
} from "@/lib/custom-report-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  if (error instanceof ReportingScopeError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Invalid custom report" },
    { status: 400 },
  );
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const p = req.nextUrl.searchParams;
    const scope = await resolveReportingScope(session, {
      kind: p.get("scope"),
      shopId: p.get("shopId"),
      enterpriseId: p.get("enterpriseId"),
    });
    const accessActor = {
      email: session.email,
      isPlatformAdmin: Boolean(session.isPlatformAdmin || session.role === "platform_admin"),
    };
    const candidates = await listCustomReports(
      accessActor,
      scope,
    );
    const reports = (await Promise.all(candidates.map(async (report) => {
      try {
        const currentScope = await resolveReportingScope(session, scopeRequest(report.scope));
        return canReadCustomReport(accessActor, report, currentScope) ? report : null;
      } catch (error) {
        if (error instanceof ReportingScopeError) return null;
        throw error;
      }
    }))).filter((report): report is NonNullable<typeof report> => report !== null);
    return NextResponse.json({ ok: true, reports: reports.map((report) => customReportJson(report)) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json() as Record<string, unknown>;
    const requestedScope = validateCustomReportScope(body.scope);
    const resolved = await resolveReportingScope(session, scopeRequest(requestedScope));
    const report = await createCustomReport(session.email, {
      name: validateCustomReportName(body.name),
      scope: requestedScope,
      sharing: validateCustomReportSharing(body.sharing, resolved),
      definition: validateCustomReportDefinition(body.definition, resolved),
    });
    return NextResponse.json({ ok: true, report: customReportJson(report, true) }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}