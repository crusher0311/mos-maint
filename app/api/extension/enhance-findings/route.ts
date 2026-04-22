import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { getOpenAI, DEFAULT_MODEL } from "@/lib/ai";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { getDb as getSupabaseDb } from "@/lib/db/drizzle";
import { enhanceCorrections } from "@/lib/db/schema/enhance-corrections";
import { desc, eq } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

interface FindingInput {
  taskId: number;
  taskName: string;
  finding: string;
  rating?: string;
}

interface EnhancedFinding {
  taskId: number;
  taskName: string;
  original: string;
  enhanced: string;
}

const SYSTEM_PROMPT = `You are a professional automotive service advisor writing inspection findings for customers.

Your job is to take a technician's raw inspection notes and rewrite them into clear, professional, customer-facing language.

Rules:
- Keep the same meaning and technical accuracy
- Use proper grammar, spelling, and punctuation
- Be concise but thorough — typically 1-2 sentences
- Use professional automotive terminology that customers can understand
- Don't add recommendations unless the tech's note implies one
- Don't exaggerate or minimize the severity
- Don't add information that wasn't in the original note
- If the note mentions measurements (mm, PSI, etc.), keep them
- Start with the component/system name when natural
- Never use ALL CAPS for emphasis
- If the original note is already professional and clear, return it with only minor cleanup

Examples:
- "brake pads worn 3mm" → "Front brake pads are worn to 3mm and will need replacement soon."
- "oil leak from valve cover" → "Oil leak observed from the valve cover gasket. Recommend resealing to prevent further oil loss."
- "tire tread low rf" → "Right front tire tread depth is low and approaching the wear indicator."
- "ac blowing warm needs recharge" → "A/C system is blowing warm air. Recommend evacuating and recharging the refrigerant."
- "all good" → "Inspected and found to be in good condition."`;

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const { findings, vehicleInfo, shopId, provider } = body;

  // Feature gate: requires `enhance_notes`. The extension sends the SMS shop ID
  // in the body field `shopId` (same identifier other extension endpoints call
  // `smsShopId`), so we map it across.
  const guard = await guardExtensionShopRequest(request, {
    smsShopId: shopId,
    provider,
    requiredFeatures: ["enhance_notes"],
    featureLabel: "Enhance Notes",
    corsHeaders,
  });
  if (!guard.ok) return guard.response;

  if (!findings || !Array.isArray(findings) || findings.length === 0) {
    return NextResponse.json(
      { error: "findings array required" },
      { status: 400, headers: corsHeaders }
    );
  }

  if (findings.length > 200) {
    return NextResponse.json(
      { error: "Maximum 200 findings per request" },
      { status: 400, headers: corsHeaders }
    );
  }

  const validFindings: FindingInput[] = findings.filter(
    (f: any) => f.taskId && f.finding && typeof f.finding === "string" && f.finding.trim().length > 0
  );

  if (validFindings.length === 0) {
    return NextResponse.json(
      { error: "No findings with text to enhance" },
      { status: 400, headers: corsHeaders }
    );
  }

  const startTime = Date.now();

  try {
    const openai = getOpenAI();

    const vehicleContext = vehicleInfo
      ? `Vehicle: ${vehicleInfo.year || ""} ${vehicleInfo.make || ""} ${vehicleInfo.model || ""} ${vehicleInfo.trim || ""}`.trim()
      : "";

    let shopExamples = "";
    if (shopId) {
      try {
        const pgDb = getSupabaseDb();
        const corrections = await pgDb
          .select({
            aiSuggested: enhanceCorrections.aiSuggested,
            advisorWrote: enhanceCorrections.advisorWrote,
          })
          .from(enhanceCorrections)
          .where(eq(enhanceCorrections.shopId, String(shopId)))
          .orderBy(desc(enhanceCorrections.createdAt))
          .limit(20);

        if (corrections.length > 0) {
          const deduped = new Map<string, string>();
          for (const c of corrections) {
            if (c.aiSuggested && c.advisorWrote && c.aiSuggested !== c.advisorWrote) {
              deduped.set(c.aiSuggested, c.advisorWrote);
            }
          }
          if (deduped.size > 0) {
            const examples = Array.from(deduped.entries())
              .slice(0, 15)
              .map(([ai, advisor]) => `- "${ai}" → "${advisor}"`)
              .join("\n");
            shopExamples = `\n\nThis shop's advisors prefer the following phrasing (use these as guidance for terminology and style):\n${examples}`;
          }
        }
      } catch (err) {
        console.warn("[Enhance Findings] Failed to load shop corrections:", err);
      }
    }

    const userPrompt = validFindings.map((f, i) =>
      `${i + 1}. [${f.taskName}] "${f.finding}"`
    ).join("\n");

    const baseInstruction = "Rewrite each technician finding below into professional customer-facing language. Return ONLY a JSON array of objects with \"index\" (1-based) and \"enhanced\" fields. No markdown, no explanation.";

    let fullPrompt = "";
    if (vehicleContext) fullPrompt += vehicleContext + "\n\n";
    fullPrompt += baseInstruction;
    if (shopExamples) fullPrompt += shopExamples;
    fullPrompt += "\n\n" + userPrompt;

    const completion = await openai.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: fullPrompt },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    });

    const responseText = completion.choices?.[0]?.message?.content?.trim() || "";

    let parsed: any[];
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array found");
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      console.error("[Enhance Findings] Failed to parse AI response:", responseText.substring(0, 200));
      return NextResponse.json(
        { error: "AI returned invalid format" },
        { status: 500, headers: corsHeaders }
      );
    }

    const enhanced: EnhancedFinding[] = validFindings.map((f, i) => {
      const match = parsed.find((p: any) => p.index === i + 1);
      return {
        taskId: f.taskId,
        taskName: f.taskName,
        original: f.finding,
        enhanced: match?.enhanced || f.finding,
      };
    });

    const latencyMs = Date.now() - startTime;

    await trackApiRequest(
      "openai",
      "/enhance-findings",
      "POST",
      200,
      latencyMs,
      completion.usage?.total_tokens || 0,
      { findingsCount: validFindings.length, user: guard.user.email }
    ).catch(() => {});

    console.log(
      `[Enhance Findings] ${guard.user.email}: ${enhanced.length} findings enhanced in ${latencyMs}ms`
    );

    return NextResponse.json({
      success: true,
      enhanced,
      summary: {
        total: findings.length,
        processed: enhanced.length,
        skipped: findings.length - validFindings.length,
      },
    }, { headers: corsHeaders });
  } catch (err: any) {
    console.error("[Enhance Findings] Error:", err.message);
    return NextResponse.json(
      { error: "Failed to enhance findings: " + err.message },
      { status: 500, headers: corsHeaders }
    );
  }
}
