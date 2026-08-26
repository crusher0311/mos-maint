import { NextRequest, NextResponse } from "next/server";
import { getSession, type SessionInfo } from "@/lib/auth";
import { canReadCustomReport, canWriteCustomReport } from "@/lib/custom-report-access";
import {
  deleteCustomReport,
  findCustomReport,
  renameCustomReport,
  updateCustomReportDefinition,
} from "@/lib/data/repositories/custom-reports";
import {
  customReportJson,
  scopeRequest,
  validateCustomReportDefinition,
  validateCustomReportName,
  validateCustomReportScope,
  validateCustomReportSharing,
} from "@/lib/custom-report-api";
import { ReportingScopeError, resolveReportingScope } from "@/lib/reporting-scope";

const actor = (session: SessionInfo) => ({
  email: session.email,
  isPlatformAdmin: Boolean(session.isPlatformAdmin || session.role === "platform_admin"),
});

function failure(error: unknown) {
  if (error instanceof ReportingScopeError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Invalid custom report" },
    { status: 400 },
  );
}

async function loadAuthorized(id: string, session: SessionInfo, write = false) {
  const report = await findCustomReport(id);
  if (!report) return { response: NextResponse.json({ error: "Report not found" }, { status: 404 }) };
  const scope = await resolveReportingScope(session, scopeRequest(report.scope));
  const allowed = write
    ? canWriteCustomReport(actor(session), report)
    : canReadCustomReport(actor(session), report, scope);
  if (!allowed) return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { report, scope };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const auth = await loadAuthorized((await params).id, session);
    if (auth.response) return auth.response;
    return NextResponse.json({ ok: true, report: customReportJson(auth.report!, true) });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const id = (await params).id;
    const auth = await loadAuthorized(id, session, true);
    if (auth.response) return auth.response;
    const body = await req.json() as Record<string, unknown>;
    let updated;
    if (body.definition === undefined && body.scope === undefined && body.sharing === undefined) {
      updated = await renameCustomReport(id, actor(session), validateCustomReportName(body.name));
    } else {
      const requestedScope = body.scope === undefined
        ? auth.report!.scope
        : validateCustomReportScope(body.scope);
      const resolved = await resolveReportingScope(session, scopeRequest(requestedScope));
      updated = await updateCustomReportDefinition(id, actor(session), {
        definition: body.definition === undefined
          ? validateCustomReportDefinition(
              auth.report!.versions.find((version) => version.version === auth.report!.currentVersion)?.definition,
              resolved,
            )
          : validateCustomReportDefinition(body.definition, resolved),
        scope: requestedScope,
        sharing: validateCustomReportSharing(
          body.sharing === undefined ? auth.report!.sharing : body.sharing,
          resolved,
        ),
      });
      if (body.name !== undefined && updated) {
        updated = await renameCustomReport(id, actor(session), validateCustomReportName(body.name));
      }
    }
    if (!updated) return NextResponse.json({ error: "Report was modified; reload and try again" }, { status: 409 });
    return NextResponse.json({ ok: true, report: customReportJson(updated, true) });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const id = (await params).id;
    const auth = await loadAuthorized(id, session, true);
    if (auth.response) return auth.response;
    if (!await deleteCustomReport(id, actor(session))) {
      return NextResponse.json({ error: "Report not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}