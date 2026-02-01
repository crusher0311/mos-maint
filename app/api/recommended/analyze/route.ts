// app/api/recommended/analyze/route.ts
import { NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import { logUsage, estimateCost, estimateTokens } from "@/lib/usage";
import { trackApiRequest } from "@/lib/api-usage-tracker";

export const runtime = "nodejs";

function fmt(n?: number | null) {
  return typeof n === "number" ? n.toLocaleString() : "";
}
function toSquish(vin: string) {
  const v = String(vin || "").toUpperCase().trim();
  return v.slice(0, 8) + v.slice(9, 11);
}
function safeJson(v: any) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v ?? "");
  }
}
function extractJsonBlock(text: string): string | null {
  if (!text) return null;
  const fenceJson = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenceJson) return fenceJson[1].trim();
  const fence = text.match(/```\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const brace = text.match(/\{[\s\S]*\}$/m);
  if (brace) return brace[0].trim();
  return null;
}

async function callOpenAI(model: string, systemPrompt: string, userPrompt: string): Promise<{
  ok: boolean; text?: string; error?: string;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY is not set" };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    return { ok: false, error: `OpenAI ${resp.status}: ${msg}` };
  }

  const data: any = await resp.json().catch(() => ({}));
  const outputText =
    data?.output_text ??
    (Array.isArray(data?.output)
      ? data.output
          .flatMap((part: any) => Array.isArray(part?.content) ? part.content : [])
          .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
          .join("")
          .trim()
      : "") ??
    "";

  return { ok: true, text: String(outputText || "").trim() };
}

async function getLocalOeFromPostgres(vin: string) {
  const SQUISH = toSquish(vin);

  const items = await sql`
    WITH vin_maint AS (
      SELECT DISTINCT lvm.vin_maintenance_id, lvm.maintenance_id
      FROM dataone_lkp_vin_maintenance lvm
      WHERE lvm.squish = ${SQUISH}
    ),
    intervals AS (
      SELECT vm.maintenance_id, lvi.maintenance_interval_id
      FROM vin_maint vm
      JOIN dataone_lkp_vin_maintenance_interval lvi ON lvi.vin_maintenance_id = vm.vin_maintenance_id
    ),
    interval_defs AS (
      SELECT i.maintenance_id, dmi.interval_type, dmi.value, dmi.units, dmi.initial_value
      FROM intervals i
      JOIN dataone_def_maintenance_interval dmi ON dmi.maintenance_interval_id = i.maintenance_interval_id
    ),
    grouped AS (
      SELECT 
        vm.maintenance_id,
        dm.maintenance_name as name,
        dm.maintenance_category as category,
        dm.maintenance_notes as notes,
        MAX(CASE WHEN id.units = 'Miles' THEN id.value END) as miles,
        MAX(CASE WHEN id.units = 'Months' THEN id.value END) as months
      FROM vin_maint vm
      JOIN dataone_def_maintenance dm ON dm.maintenance_id = vm.maintenance_id
      LEFT JOIN interval_defs id ON id.maintenance_id = vm.maintenance_id
      GROUP BY vm.maintenance_id, dm.maintenance_name, dm.maintenance_category, dm.maintenance_notes
    )
    SELECT maintenance_id, name, category, notes, miles, months
    FROM grouped
    ORDER BY category, name
    LIMIT 200
  `;

  return items;
}

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const vin = String(body?.vin || "").toUpperCase().trim();
    const model = String(body?.model || "gpt-4.1");

    let dvi = body?.dviData ?? null;
    let carfax = body?.carfaxData ?? null;
    let oem = Array.isArray(body?.oemData) ? body.oemData : null;

    if (vin && (!dvi || !carfax || !oem)) {
      const vehicleRows = await sql`
        SELECT shop_id FROM vehicles WHERE vin = ${vin}
      `;
      const vehicle = vehicleRows[0] as any;

      const shopId = Number(vehicle?.shop_id ?? NaN);

      const roRows = await sql`
        SELECT ro_number, updated_at, created_at FROM work_orders
        WHERE vin = ${vin}
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 1
      `;
      const ro = roRows[0] as any;

      if (!dvi) {
        try {
          const afCfg = await resolveAutoflowConfig(shopId);
          dvi =
            ro?.ro_number && afCfg.configured
              ? await fetchDviWithCache(shopId, String(ro.ro_number), 10 * 60 * 1000)
              : { ok: false, error: ro?.ro_number ? "AutoFlow not connected." : "No RO found." };
        } catch {
          dvi = { ok: false, error: "Failed to fetch DVI" };
        }
      }

      if (!carfax) {
        try {
          const carfaxCfg = await resolveCarfaxConfig(shopId);
          carfax = carfaxCfg.configured
            ? await fetchCarfaxWithCache(shopId, vin, 7 * 24 * 60 * 60 * 1000)
            : { ok: false, error: "CARFAX not configured." };
        } catch {
          carfax = { ok: false, error: "Failed to fetch CARFAX" };
        }
      }

      if (!oem) {
        try {
          oem = await getLocalOeFromPostgres(vin);
        } catch {
          oem = [];
        }
      }
    }

    const systemPrompt =
      "You are a master service advisor with decades of experience. " +
      "Based ONLY on the DVI, CARFAX, and OEM data provided (some may be missing), " +
      "produce a prioritized list of service recommendations for the customer. " +
      "Return a STRICT JSON object with the shape:\n" +
      `{
  "recommendations": [
    {
      "title": "string",
      "why": "string",
      "priority": number,
      "sources": ["DVI","CARFAX","OEM"],
      "suggestedTiming": "string",
      "notes": "string"
    }
  ]
}\n` +
      "Keep titles concise and actionable. Use the 'sources' field to reflect which inputs informed the item. " +
      "Lower numbers in 'priority' mean higher urgency. If a source is missing, proceed with the remaining data.";

    const userPrompt = [
      "### DATA (one or more may be unavailable)",
      "",
      "DVI:",
      safeJson(dvi ?? { ok: false, error: "Not provided" }),
      "",
      "CARFAX:",
      safeJson(carfax ?? { ok: false, error: "Not provided" }),
      "",
      "OEM:",
      safeJson(Array.isArray(oem) ? oem : []),
    ].join("\n");

    let logShopId: string | number | null = body?.shopId || null;
    if (!logShopId && vin) {
      try {
        const vehicleRows = await sql`SELECT shop_id FROM vehicles WHERE vin = ${vin}`;
        const vehicleForLog = vehicleRows[0] as any;
        logShopId = vehicleForLog?.shop_id;
      } catch {}
    }

    const aiStartTime = Date.now();
    const ai = await callOpenAI(model, systemPrompt, userPrompt);
    const aiDuration = Date.now() - aiStartTime;
    
    trackApiRequest('openai', '/responses', 'POST', ai.ok ? 200 : 500, aiDuration, logShopId ? Number(logShopId) : undefined).catch(() => {});
    
    if (!ai.ok) {
      return NextResponse.json({ ok: false, error: ai.error ?? "Analyzer failed" }, { status: 500 });
    }

    const raw = ai.text ?? "";
    let parsed: any = null;
    const jsonBlock = extractJsonBlock(raw);
    if (jsonBlock) {
      try {
        parsed = JSON.parse(jsonBlock);
      } catch {
        parsed = null;
      }
    }

    const inputTokens = estimateTokens(systemPrompt + userPrompt);
    const outputTokens = estimateTokens(raw);
    const cost = estimateCost(model, inputTokens, outputTokens);
    
    if (logShopId) {
      try {
        await logUsage({
          shopId: String(logShopId),
          action: "analyze",
          model,
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          estimatedCost: cost,
          vin: vin || undefined,
        });
      } catch (logErr) {
        console.error("Failed to log usage:", logErr);
      }
    }

    return NextResponse.json({
      ok: true,
      modelUsed: model,
      raw,
      parsed,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message ?? "Unknown error" }, { status: 500 });
  }
}
