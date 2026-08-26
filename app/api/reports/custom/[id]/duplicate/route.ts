import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { canReadCustomReport } from "@/lib/custom-report-access";
import { customReportJson, scopeRequest, validateCustomReportName } from "@/lib/custom-report-api";
import {
  duplicateCustomReport,
  findCustomReport,
} from "@/lib/data/repositories/custom-reports";
import { ReportingScopeError, resolveReportingScope } from "@/lib/reporting-scope";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const source = await findCustomReport((await params).id);
    if (!source) return NextResponse.json({ error: "Report not found" }, { status: 404 });
    const scope = await resolveReportingScope(session, scopeRequest(source.scope));
    const actor = {
      email: session.email,
      isPlatformAdmin: Boolean(session.isPlatformAdmin || session.role === "platform_admin"),
    };
    if (!canReadCustomReport(actor, source, scope)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const name = validateCustomReportName(body.name ?? `${source.name} copy`);
    const duplicate = await duplicateCustomReport(source, session.email, name);
    return NextResponse.json({ ok: true, report: customReportJson(duplicate, true) }, { status: 201 });
  } catch (error) {
    if (error instanceof ReportingScopeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to duplicate report" },
      { status: 400 },
    );
  }
}