import type { NextRequest } from "next/server";
import { logUsage, estimateTokens, estimateCost } from "@/lib/usage";

function safeJsonParse<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    // Try to pull a ```json ... ``` block
    const m = text.match(/```json\s*([\s\S]*?)\s*```/i);
    if (m) {
      try {
        return JSON.parse(m[1]) as T;
      } catch {
        return null;
      }
    }
    // Try to pull any ``` ... ``` block
    const m2 = text.match(/```\s*([\s\S]*?)\s*```/);
    if (m2) {
      try {
        return JSON.parse(m2[1]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function summarizeDvi(dviData: any): string {
  if (!dviData || !dviData.ok || !Array.isArray(dviData.categories) || dviData.categories.length === 0) {
    return "No DVI data available.";
  }
  const lines: string[] = [];
  for (const cat of dviData.categories) {
    const cname = cat?.name || "(Category)";
    if (Array.isArray(cat?.items)) {
      for (const it of cat.items) {
        const name = it?.name ?? "(item)";
        const status = String(it?.status ?? "");
        let statusText = status;
        if (status === "0") statusText = "RED";
        else if (status === "1") statusText = "YELLOW";
        else if (status === "2") statusText = "GREEN";
        const notes = (it?.notes ?? "").toString().trim();
        lines.push(`- [${statusText}] ${cname}: ${name}${notes ? ` — ${notes}` : ""}`);
      }
    }
  }
  return lines.length ? lines.join("\n") : "No DVI findings listed.";
}

function summarizeCarfax(carfaxData: any): string {
  if (!carfaxData || !carfaxData.ok) return "No CARFAX data available.";
  const parts: string[] = [];
  const last = carfaxData.lastReportedMileage;
  if (typeof last === "number") parts.push(`Last Reported Miles: ${last.toLocaleString()}`);
  if (Array.isArray(carfaxData.serviceRecords) && carfaxData.serviceRecords.length > 0) {
    parts.push("Recent Service Records:");
    for (const r of carfaxData.serviceRecords.slice(0, 20)) {
      const date = r?.date ?? "";
      const odo = typeof r?.odometer === "number" ? r.odometer.toLocaleString() : "";
      const desc = (r?.description ?? "").toString().trim();
      parts.push(`- ${date}${odo ? ` • ${odo} mi` : ""}${desc ? ` • ${desc}` : ""}`);
    }
  } else {
    parts.push("No service records found.");
  }
  return parts.join("\n");
}

function summarizeOem(oemData: any): string {
  if (!Array.isArray(oemData) || oemData.length === 0) return "No OEM schedule available.";
  const lines: string[] = [];
  for (const it of oemData) {
    const name = it?.name ?? "(service)";
    const cat = it?.category ?? "";
    const miles = typeof it?.miles === "number" ? `${it.miles} mi` : "";
    const months = typeof it?.months === "number" ? `${it.months} mo` : "";
    const interval = [miles, months].filter(Boolean).join(" / ");
    lines.push(`- ${name}${cat ? ` (${cat})` : ""}${interval ? ` — ${interval}` : ""}`);
  }
  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  // Parse JSON body safely with defaults so missing parts never crash
  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    payload = {};
  }

  const model = (payload?.model as string) || "gpt-4.1";
  const dviData = payload?.dviData ?? null;
  const carfaxData = payload?.carfaxData ?? null;
  const oemData = payload?.oemData ?? [];
  const shopId = payload?.shopId ?? null;
  const vin = payload?.vin ?? null;
  const userEmail = payload?.userEmail ?? null;

  // Build source summaries (use whatever is available)
  const dviText = summarizeDvi(dviData);
  const carfaxText = summarizeCarfax(carfaxData);
  const oemText = summarizeOem(oemData);

  // If no sources at all, short-circuit
  if (
    (!dviData || !dviData.ok) &&
    (!carfaxData || !carfaxData.ok) &&
    (!Array.isArray(oemData) || oemData.length === 0)
  ) {
    return Response.json({
      ok: true,
      modelUsed: model,
      parsed: { recommendations: [] },
      raw: "No DVI, CARFAX, or OEM data provided.",
    });
  }

  const systemPrompt =
    "You are a master service advisor with decades of experience at a top independent shop. " +
    "Given the DVI findings (if any), the CARFAX history (if any), and the OEM maintenance schedule (if any), " +
    "produce a prioritized list of service recommendations for the customer. " +
    "Be practical, safety-focused, and specific. " +
    "Return ONLY valid JSON with this shape:\n" +
    `{"recommendations":[{"title":string,"why":string,"priority":number,"sources":["DVI"|"CARFAX"|"OEM"|...],"suggestedTiming"?:string,"notes"?:string}]}`;

  const userPrompt =
`DVI:
${dviText}

CARFAX:
${carfaxText}

OEM:
${oemText}

Instructions:
- Use the data that exists; if something is missing, proceed without it.
- Prioritize safety and due/overdue items first.
- Keep "title" short and clear. Put reasoning in "why".
- Use integer "priority" where 1 is highest priority.
- Include a "sources" array (e.g., ["DVI","OEM"]).
- If timing is relevant, include "suggestedTiming" (e.g., "ASAP", "Next visit", "Within 5k mi").
- Output JSON only (no markdown).`;

  // Require an API key to actually call OpenAI
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const mock = {
      recommendations: [
        {
          title: "Brake inspection/repair",
          why: "High safety impact; flagged in inspection history and typical at current mileage.",
          priority: 1,
          sources: ["DVI", "OEM"],
          suggestedTiming: "ASAP",
        },
      ],
    };
    return Response.json({
      ok: true,
      modelUsed: model,
      parsed: mock,
      raw: JSON.stringify(mock, null, 2),
    });
  }

  // Call OpenAI Chat Completions (works with gpt-4.1 / gpt-4o / 4.1-turbo etc.)
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      return Response.json({ ok: false, error: `OpenAI error: ${resp.status} ${t}` }, { status: 500 });
    }

    const data = await resp.json();
    const raw =
      data?.choices?.[0]?.message?.content ??
      (typeof data === "string" ? data : JSON.stringify(data));

    const parsed = safeJsonParse<any>(raw);

    const inputTokens = data?.usage?.prompt_tokens ?? estimateTokens(systemPrompt + userPrompt);
    const outputTokens = data?.usage?.completion_tokens ?? estimateTokens(raw);
    
    if (shopId) {
      try {
        await logUsage({
          shopId: String(shopId),
          userEmail: userEmail || undefined,
          action: "analyze",
          model,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          vin: vin || undefined,
        });
      } catch (logErr) {
        console.error("Failed to log usage:", logErr);
      }
    }

    return Response.json({
      ok: true,
      modelUsed: model,
      parsed: parsed ?? null,
      raw,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message ?? "Analyzer failed." }, { status: 500 });
  }
}
