import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOpenAI, trackOpenAiCall } from "@/lib/ai";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { enforceAiBudget } from "@/lib/ai-budget";
import { isPlatformAdmin as isPlatformAdminEmail } from "@/lib/super-admins";

export const dynamic = "force-dynamic";

interface LanguageRequest {
  text: string;
  lineItems?: Array<{
    description: string;
    type?: string;
    hasLabor?: boolean;
    hasParts?: boolean;
    laborHours?: number;
    partsTotal?: number;
  }>;
}

interface CompletionIssue {
  type: "missing_parts" | "missing_labor" | "missing_description" | "incomplete";
  severity: "warning" | "info";
  message: string;
  lineIndex?: number;
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const body: LanguageRequest = await req.json();
    const { text, lineItems } = body;

    if (!text && (!lineItems || lineItems.length === 0)) {
      return NextResponse.json({ ok: false, error: "text or lineItems is required" }, { status: 400 });
    }

    const isAdmin = await isPlatformAdminEmail(session.email);
    const blocked = await enforceAiBudget({
      shopId: Number(session.shopId),
      route: "/api/estimate-assist/language",
      isPlatformAdmin: isAdmin,
    });
    if (blocked) return blocked;

    const completionIssues: CompletionIssue[] = [];
    if (lineItems) {
      lineItems.forEach((item, index) => {
        if (item.hasLabor && !item.hasParts && item.type !== "diagnostic" && item.type !== "inspection") {
          completionIssues.push({
            type: "missing_parts",
            severity: "warning",
            message: `Line ${index + 1} "${item.description}" has labor but no parts. Most repair jobs require parts.`,
            lineIndex: index,
          });
        }
        if (item.hasParts && !item.hasLabor) {
          completionIssues.push({
            type: "missing_labor",
            severity: "warning",
            message: `Line ${index + 1} "${item.description}" has parts but no labor. Parts typically require installation labor.`,
            lineIndex: index,
          });
        }
        if (!item.description || item.description.trim().length < 5) {
          completionIssues.push({
            type: "missing_description",
            severity: "warning",
            message: `Line ${index + 1} has a missing or incomplete description.`,
            lineIndex: index,
          });
        }
      });
    }

    const openai = getOpenAI();
    const startTime = Date.now();

    const inputText = lineItems
      ? lineItems.map((item, i) => `${i + 1}. ${item.description} (${item.type || 'unknown type'}, labor: ${item.laborHours || 'N/A'}h, parts: $${item.partsTotal || 'N/A'})`).join("\n")
      : text;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an experienced automotive service advisor who writes professional estimate descriptions.

Given estimate line item text, produce two versions:
1. "technical" - Professional technical language for the repair order / technician. Use proper automotive terminology, include torque specs references, fluid types, and procedure details where relevant.
2. "customer" - Customer-friendly language that explains what the work is and why it matters, without jargon. Focus on benefits and safety.

Return a JSON object with this shape:
{
  "technical": "string - the full technical version",
  "customer": "string - the full customer-facing version",
  "lineItems": [
    {
      "original": "string",
      "technical": "string",
      "customer": "string"
    }
  ]
}

If there are multiple line items, include each in the lineItems array. If just free text, provide the overall technical and customer versions.`,
        },
        {
          role: "user",
          content: `Convert this estimate text into technical and customer-facing versions:\n\n${inputText}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    });

    const elapsed = Date.now() - startTime;
    trackOpenAiCall(Number(session.shopId), "/api/estimate-assist/language", completion, elapsed);

    const aiContent = completion.choices[0]?.message?.content || "{}";
    let parsed: any = {};
    try {
      parsed = JSON.parse(aiContent);
    } catch {
      parsed = { technical: aiContent, customer: aiContent, lineItems: [] };
    }

    return NextResponse.json({
      ok: true,
      technical: parsed.technical || "",
      customer: parsed.customer || "",
      lineItems: parsed.lineItems || [],
      completionIssues,
    });
  } catch (error: any) {
    console.error("[Estimate Language] Error:", error);
    return NextResponse.json({ ok: false, error: error.message || "Failed to process language" }, { status: 500 });
  }
}
