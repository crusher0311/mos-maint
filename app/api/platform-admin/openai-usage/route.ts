import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOpenAiUsageRows } from "@/lib/data/repositories/openai-usage";
import { summarizeAiUsage } from "@/lib/openai-usage";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!session.isPlatformAdmin) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  const days = Number(req.nextUrl.searchParams.get("days") ?? 30);
  if (![1, 7, 30].includes(days)) return NextResponse.json({ ok: false, error: "Choose 1, 7 or 30 days." }, { status: 400 });
  const to = new Date(), from = new Date(to.getTime() - days * 86400000);
  try {
    const rows = await getOpenAiUsageRows(from, to);
    return NextResponse.json({ ok: true, days, from, to, truncated: rows.length > 10000,
      ...summarizeAiUsage(rows.slice(0, 10000)) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false, error: "AI usage is unavailable. Please retry." }, { status: 503 });
  }
}
