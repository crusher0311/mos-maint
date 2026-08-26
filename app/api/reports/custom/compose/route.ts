import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { enforceAiBudget } from "@/lib/ai-budget";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { isPlatformAdmin } from "@/lib/super-admins";
import {
  buildCustomReportMessages,
  CUSTOM_REPORT_AI_JSON_SCHEMA,
  parseCustomReportProposalJson,
} from "@/lib/custom-report-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const prompt = typeof (body as { prompt?: unknown })?.prompt === "string" ? (body as { prompt: string }).prompt.trim() : "";
  if (!prompt || prompt.length > 2_000) return NextResponse.json({ error: "Prompt must be between 1 and 2,000 characters" }, { status: 400 });

  const platformAdmin = session.isPlatformAdmin || await isPlatformAdmin(session.email);
  const blocked = await enforceAiBudget({
    shopId: Number(session.shopId),
    route: "/api/reports/custom/compose",
    isPlatformAdmin: platformAdmin,
  });
  if (blocked) return blocked;

  try {
    const startedAt = Date.now();
    const completion = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: buildCustomReportMessages(prompt),
      response_format: { type: "json_schema", json_schema: CUSTOM_REPORT_AI_JSON_SCHEMA },
      max_tokens: 1_000,
      temperature: 0,
    });
    trackOpenAiCall(session.shopId, "/api/reports/custom/compose", completion, Date.now() - startedAt);
    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("AI returned an empty proposal");
    const proposal = parseCustomReportProposalJson(content);
    return NextResponse.json({ ok: true, proposal });
  } catch (error) {
    console.error("[custom-report-compose] failed", error);
    return NextResponse.json({ error: "A valid report proposal could not be created. Try rephrasing your request." }, { status: 502 });
  }
}