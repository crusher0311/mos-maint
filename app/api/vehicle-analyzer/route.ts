// app/api/vehicle-analyzer/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getOpenAI, DEFAULT_MODEL, MODELS } from "@/lib/ai";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import { logUsage, estimateCost } from "@/lib/usage";
import { trackApiRequest } from "@/lib/api-usage-tracker";

// small utils
function parseCarfaxDate(d?: string | null): Date | null {
  if (!d) return null;
  const trimmed = String(d).trim();
  const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = Number(m[1]), dd = Number(m[2]), yy = Number(m[3]);
    const dt = new Date(yy, mm - 1, dd);
    return isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(trimmed);
  return isNaN(dt.getTime()) ? null : dt;
}
function toSquish(vin: string) {
  const v = String(vin).toUpperCase().trim();
  return v.slice(0, 8) + v.slice(9, 11);
}

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
        squish: { $first: "$squish" },
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
        squish: { $first: "$squish" },
        maintenance_name: { $first: "$maintenance_name" },
        maintenance_category: { $first: "$maintenance_category" },
        maintenance_notes: { $first: "$maintenance_notes" },
        intervals: {
          $push: {
            interval_id: "$_id.interval_id",
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
    {
      $project: {
        _id: 0,
        maintenance_id: "$_id",
        name: "$maintenance_name",
        category: "$maintenance_category",
        notes: "$maintenance_notes",
        miles: 1,
        months: 1,
        intervals: 1,
      },
    },
    { $sort: { category: 1, name: 1 } },
    { $limit: 200 },
  ];

  const items = await db
    .collection("dataone_lkp_vin_maintenance")
    .aggregate(pipeline, { allowDiskUse: true, hint: "squish_1" })
    .toArray();

  return { ok: true as const, vin, squish: SQUISH, count: items.length, items };
}

export async function POST(req: NextRequest) {
  try {
    const { vin, shopId, model } = await req.json();
    if (!vin || !shopId) {
      return NextResponse.json({ ok: false, error: "vin and shopId are required" }, { status: 400 });
    }

    // Validate/choose model
    const chosenModel = MODELS.includes(model) ? model : DEFAULT_MODEL;

    const db = await getDb();

    // Vehicle basics + current miles
    const vehicle = await db.collection("vehicles").findOne(
      { vin: String(vin).toUpperCase(), shopId: Number(shopId) || String(shopId) },
      { projection: { year: 1, make: 1, model: 1, lastMileage: 1, odometer: 1 } }
    );

    const currentMiles =
      (typeof vehicle?.lastMileage === "number" && vehicle.lastMileage > 0 && vehicle.lastMileage) ||
      (typeof vehicle?.odometer === "number" && vehicle.odometer > 0 && vehicle.odometer) ||
      null;

    // Latest RO
    const ros = await db
      .collection("repair_orders")
      .find({ $or: [{ vin: String(vin).toUpperCase() }, { vehicleId: vehicle?._id }] })
      .project({ roNumber: 1, status: 1, mileage: 1, updatedAt: 1, createdAt: 1 })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(1)
      .toArray();
    const latestRoNumber = ros[0]?.roNumber ?? null;

    // DVI
    const autoCfg = await resolveAutoflowConfig(Number(shopId));
    const dvi =
      latestRoNumber && autoCfg.configured
        ? await fetchDviWithCache(Number(shopId), String(latestRoNumber), 10 * 60 * 1000)
        : { ok: false, error: latestRoNumber ? "AutoFlow not connected." : "No RO found." };

    // CARFAX
    const carfaxCfg = await resolveCarfaxConfig(Number(shopId));
    const carfax = carfaxCfg.configured
      ? await fetchCarfaxWithCache(Number(shopId), String(vin).toUpperCase(), 7 * 24 * 60 * 60 * 1000)
      : { ok: false, error: "CARFAX not configured." as const };

    // OEM
    const oem = await getLocalOeFromMongo(String(vin));

    // Compact inputs
    const dviSummary = (dvi as any)?.ok
      ? {
          sheetName: (dvi as any).sheetName,
          timestamp: (dvi as any).timestamp,
          advisor: (dvi as any).advisor,
          technician: (dvi as any).technician,
          categories: Array.isArray((dvi as any).categories)
            ? (dvi as any).categories.map((c: any) => ({
                name: c?.name,
                video: !!c?.video,
                items: Array.isArray(c?.items)
                  ? c.items.slice(0, 60).map((it: any) => ({
                      name: it?.name,
                      status: String(it?.status ?? ""),
                      notes: it?.notes || "",
                    }))
                  : [],
              }))
            : [],
        }
      : { ok: false, error: (dvi as any)?.error ?? "No DVI" };

    const carfaxSummary = (carfax as any)?.ok
      ? {
          vin: (carfax as any).vin,
          reportDate: (carfax as any).reportDate,
          lastReportedMileage: (carfax as any).lastReportedMileage,
          serviceRecords: Array.isArray((carfax as any).serviceRecords)
            ? (carfax as any).serviceRecords.map((r: any) => ({
                date: r?.date,
                odometer: r?.odometer,
                description: r?.description,
                location: r?.location,
              }))
            : [],
        }
      : { ok: false, error: (carfax as any)?.error ?? "No CARFAX" };

    const oemSummary = {
      count: oem.count,
      items: (oem.items || []).map((x: any) => ({
        maintenance_id: x.maintenance_id,
        name: x.name,
        category: x.category,
        miles: x.miles ?? null,
        months: x.months ?? null,
        notes: x.notes ?? null,
      })),
    };

    // Prompt
    const system = [
      "You are a master service advisor with decades of experience.",
      "Given DVI findings, CARFAX history, and OEM schedules, produce a prioritized recommendation list for the customer.",
      "Prioritize safety, reliability, warranty compliance, and cost-effectiveness.",
      "Explain briefly why each item is recommended and cite the data source(s) used (DVI/CARFAX/OEM).",
      "Return JSON with this shape:",
      `{
        "vehicle": { "year": number|null, "make": string|null, "model": string|null, "currentMiles": number|null },
        "recommendations": [
          {
            "title": string,
            "priority": number,
            "urgency": "overdue"|"soon"|"upcoming"|null,
            "sources": string[],
            "estimatedCostNote": string|null,
            "why": string
          }
        ],
        "notesForAdvisor": string
      }`,
      "Keep titles concise. Keep why <= 2 sentences. Use all three data sources when helpful.",
    ].join("\n");

    const user = {
      vehicle: {
        year: vehicle?.year ?? null,
        make: vehicle?.make ?? null,
        model: vehicle?.model ?? null,
        currentMiles,
        vin: String(vin).toUpperCase(),
      },
      dvi: dviSummary,
      carfax: carfaxSummary,
      oem: oemSummary,
    };

    const startTime = Date.now();
    const openai = getOpenAI();
    const resp = await openai.chat.completions.create({
      model: chosenModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: "Based on this vehicle’s DVI, CARFAX, and OEM schedule, list and prioritize all recommendations as JSON." },
        { role: "user", content: JSON.stringify(user) },
      ],
    });
    
    // Track API request for traffic monitoring
    trackApiRequest('openai', '/chat/completions', 'POST', 200, Date.now() - startTime, Number(shopId)).catch(() => {});

    const raw = resp.choices?.[0]?.message?.content || "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { parsed = { parseError: true, raw }; }

    // Log usage for analytics
    const inputTokens = resp.usage?.prompt_tokens || 0;
    const outputTokens = resp.usage?.completion_tokens || 0;
    const cost = estimateCost(chosenModel, inputTokens, outputTokens);
    
    try {
      await logUsage({
        shopId: String(shopId),
        action: "analyze",
        model: chosenModel,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCost: cost,
        vin: String(vin).toUpperCase(),
      });
    } catch (logErr) {
      console.error("Failed to log usage:", logErr);
    }

    return NextResponse.json({
      ok: true,
      model: chosenModel,
      vehicle: user.vehicle,
      data: parsed,
      _debug: process.env.NODE_ENV !== "production" ? { tokenUsage: resp.usage } : undefined,
    });
  } catch (err: any) {
    console.error("vehicle-analyzer error:", err);
    return NextResponse.json({ ok: false, error: err?.message || "Analyzer failed" }, { status: 500 });
  }
}
