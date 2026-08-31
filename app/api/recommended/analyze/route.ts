// app/api/recommended/analyze/route.ts
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import { logUsage, estimateCost, estimateTokens } from "@/lib/usage";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { enforceAiBudget } from "@/lib/ai-budget";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";

export const runtime = "nodejs";

/** Test seam — swap these in unit tests to avoid real DB / auth / AI calls. */
export const __deps = {
  getSession,
  getFeatureEntitlements,
  enforceAiBudget,
  callOpenAIFn: null as
    | null
    | ((
        model: string,
        systemPrompt: string,
        userPrompt: string,
      ) => Promise<{ ok: boolean; text?: string; error?: string }>),
  logUsage,
  trackApiRequest,
};

/* ----------------- helpers ----------------- */
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

/** Call OpenAI Responses API without the SDK */
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

/* ----------------- OEM (local) quick fetch (same shape as your pages) ----------------- */
async function getLocalOeFromMongo(vin: string) {
  const db = await getDb();
  const SQUISH = toSquish(vin);

  const pipeline = [
    { $match: { squish: SQUISH } },
    { $project: { _id: 0, squish: 1, vin_maintenance_id: 1, maintenance_id: 1 } },
    {
      $lookup: {
        from: "dataone_lkp_vin_maintenance_interval",
        let: { vmi: "$vin_maintenance_id" },
        pipeline: [
          { $match: { $expr: { $eq: ["$vin_maintenance_id", "$$vmi"] } } },
          { $project: { _id: 0, maintenance_interval_id: 1 } },
        ],
        as: "intervals",
      },
    },
    { $unwind: "$intervals" },
    {
      $lookup: {
        from: "dataone_def_maintenance_interval",
        localField: "intervals.maintenance_interval_id",
        foreignField: "maintenance_interval_id",
        as: "intDef",
      },
    },
    { $unwind: "$intDef" },
    {
      $lookup: {
        from: "dataone_def_maintenance",
        localField: "maintenance_id",
        foreignField: "maintenance_id",
        as: "def",
      },
    },
    { $unwind: "$def" },
    {
      $group: {
        _id: { maintenance_id: "$maintenance_id", interval_id: "$intervals.maintenance_interval_id" },
        maintenance_name: { $first: "$def.maintenance_name" },
        maintenance_category: { $first: "$def.maintenance_category" },
        maintenance_notes: { $first: "$def.maintenance_notes" },
        interval_type: { $first: "$intDef.interval_type" },
        value: { $first: "$intDef.value" },
        units: { $first: "$intDef.units" },
        initial_value: { $first: "$intDef.initial_value" },
      },
    },
    {
      $group: {
        _id: "$_id.maintenance_id",
        name: { $first: "$maintenance_name" },
        category: { $first: "$maintenance_category" },
        notes: { $first: "$maintenance_notes" },
        intervals: {
          $push: {
            type: "$interval_type",
            value: "$value",
            units: "$units",
            initial_value: "$initial_value",
          },
        },
      },
    },
    {
      $addFields: {
        miles: {
          $let: {
            vars: { m: { $filter: { input: "$intervals", as: "i", cond: { $eq: ["$$i.units", "Miles"] } } } },
            in: {
              $cond: [
                { $gt: [{ $size: "$$m" }, 0] },
                { $arrayElemAt: [{ $map: { input: "$$m", as: "x", in: "$$x.value" } }, 0] },
                null,
              ],
            },
          },
        },
        months: {
          $let: {
            vars: { m: { $filter: { input: "$intervals", as: "i", cond: { $eq: ["$$i.units", "Months"] } } } },
            in: {
              $cond: [
                { $gt: [{ $size: "$$m" }, 0] },
                { $arrayElemAt: [{ $map: { input: "$$m", as: "x", in: "$$x.value" } }, 0] },
                null,
              ],
            },
          },
        },
      },
    },
    { $project: { _id: 0, name: 1, category: 1, notes: 1, miles: 1, months: 1 } },
    { $sort: { category: 1, name: 1 } },
    { $limit: 200 },
  ];

  const items = await db
    .collection("dataone_lkp_vin_maintenance")
    .aggregate(pipeline, { allowDiskUse: true, hint: "squish_1" })
    .toArray();

  return items;
}

/* ----------------- route ----------------- */
export async function POST(req: Request) {
  const session = await __deps.getSession();
  if (!session?.shopId) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const vin = String(body?.vin || "").toUpperCase().trim();
    const model = String(body?.model || "gpt-4.1");

    // Resolve shopId from session first so it can gate all downstream DB reads.
    // This must come before any VIN/vehicle lookup so we can scope those queries.
    const logShopIdNum = Number(session.shopId);
    if (!Number.isFinite(logShopIdNum) || logShopIdNum <= 0) {
      return NextResponse.json(
        { ok: false, error: "Session shopId is required" },
        { status: 400 }
      );
    }
    const entitlements = await __deps.getFeatureEntitlements(logShopIdNum);
    if (!canAccessShopFeature(session, entitlements, "maintenance")) {
      return NextResponse.json({ ok: false, error: "Feature not enabled" }, { status: 403 });
    }

    // Prefer pre-fetched inputs from the UI, fallback to fetching by VIN if provided.
    let dvi = body?.dviData ?? null;
    let carfax = body?.carfaxData ?? null;
    let oem = Array.isArray(body?.oemData) ? body.oemData : null;

    // If anything missing but VIN present, try to fetch what we can.
    // All DB lookups are scoped to the session's shop so a caller cannot
    // supply a VIN from a different tenant to pull that tenant's DVI/CARFAX.
    if (vin && (!dvi || !carfax || !oem)) {
      const db = await getDb();

      // Scope vehicle lookup to session shop (String/Number legacy both handled)
      const vehicle = await db
        .collection("vehicles")
        .findOne(
          {
            vin,
            $or: [{ shopId: String(logShopIdNum) }, { shopId: logShopIdNum }],
          },
          { projection: { shopId: 1 } }
        );

      // latest RO (for DVI) — also shop-scoped
      const ro = await db
        .collection("repair_orders")
        .find({
          $or: [{ vin }, { vehicleId: vehicle?._id }],
          shopId: { $in: [String(logShopIdNum), logShopIdNum] },
        })
        .project({ roNumber: 1, updatedAt: 1, createdAt: 1 })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(1)
        .next();

      // DVI
      if (!dvi) {
        try {
          const afCfg = await resolveAutoflowConfig(logShopIdNum);
          dvi =
            ro?.roNumber && afCfg.configured
              ? await fetchDviWithCache(logShopIdNum, String(ro.roNumber), 10 * 60 * 1000)
              : { ok: false, error: ro?.roNumber ? "AutoFlow not connected." : "No RO found." };
        } catch {
          dvi = { ok: false, error: "Failed to fetch DVI" };
        }
      }

      // CARFAX
      if (!carfax) {
        try {
          const carfaxCfg = await resolveCarfaxConfig(logShopIdNum);
          carfax = carfaxCfg.configured
            ? await fetchCarfaxWithCache(logShopIdNum, vin, 7 * 24 * 60 * 60 * 1000)
            : { ok: false, error: "CARFAX not configured." };
        } catch {
          carfax = { ok: false, error: "Failed to fetch CARFAX" };
        }
      }

      // OEM local
      if (!oem) {
        try {
          oem = await getLocalOeFromMongo(vin);
        } catch {
          oem = [];
        }
      }
    }

    // Build prompts (robust to missing components)
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

    const blocked = await __deps.enforceAiBudget({
      shopId: logShopIdNum,
      route: "/api/recommended/analyze",
    });
    if (blocked) return blocked;

    // OpenAI call — use __deps override in tests, real callOpenAI in prod.
    const aiStartTime = Date.now();
    const ai = __deps.callOpenAIFn
      ? await __deps.callOpenAIFn(model, systemPrompt, userPrompt)
      : await callOpenAI(model, systemPrompt, userPrompt);
    const aiDuration = Date.now() - aiStartTime;

    // Track API request for traffic monitoring (Responses API doesn't return
    // usage, so we estimate prompt/completion tokens for budget accounting).
    const estPrompt = estimateTokens(systemPrompt + userPrompt);
    const estCompletion = estimateTokens(ai.text ?? "");
    __deps.trackApiRequest(
      "openai",
      "/api/recommended/analyze",
      "POST",
      ai.ok ? 200 : 500,
      aiDuration,
      logShopIdNum,
      { tokens: { prompt: estPrompt, completion: estCompletion, total: estPrompt + estCompletion } }
    ).catch(() => {});
    
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

    // Log usage for analytics (estimate tokens since Responses API doesn't return usage)
    const inputTokens = estimateTokens(systemPrompt + userPrompt);
    const outputTokens = estimateTokens(raw);
    const cost = estimateCost(model, inputTokens, outputTokens);
    
    if (logShopIdNum) {
      try {
        await __deps.logUsage({
          shopId: String(logShopIdNum),
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
