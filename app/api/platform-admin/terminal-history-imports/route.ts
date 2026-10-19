import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getTerminalHistoryImports } from "@/lib/data/repositories/terminal-history-imports-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePlatformAdmin(); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  try {
    return NextResponse.json(await getTerminalHistoryImports(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "History import summary unavailable. No import state was changed." },
      { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
