import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getTerminalHistoryImports } from "@/lib/data/repositories/terminal-history-imports-service";
import { InvalidHistoryCursor } from "@/lib/data/repositories/terminal-history-pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { await requirePlatformAdmin(); }
  catch { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
  try {
    const params = new URL(request.url).searchParams;
    const page = Object.fromEntries(["campaignAfter", "campaignId", "shopAfter", "receiptAfter"]
      .filter(key => params.has(key)).map(key => {
        if (params.getAll(key).length !== 1) throw new InvalidHistoryCursor();
        return [key, params.get(key)!];
      }));
    return NextResponse.json(await getTerminalHistoryImports(page), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidHistoryCursor) return NextResponse.json({ error: "Invalid history pagination cursor." },
      { status: 400, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ error: "History import summary unavailable. No import state was changed." },
      { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
