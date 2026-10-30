import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readableTireRun, tireRunResponse, TireDotError } from "@/lib/tire-dot-report-service";
import { ReportingScopeError } from "@/lib/reporting-scope";
export const dynamic = "force-dynamic";
export async function GET(_: NextRequest, context: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "private, no-store" };
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  try {
    return NextResponse.json(tireRunResponse(await readableTireRun(session, (await context.params).id)), { headers });
  } catch (e) {
    return NextResponse.json({ error: e instanceof TireDotError || e instanceof ReportingScopeError ? e.message : "Report status unavailable" },
      { status: e instanceof TireDotError || e instanceof ReportingScopeError ? e.status : 503, headers });
  }
}
