// app/api/vehicle-analyzer/route.ts
import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { getOpenAI, DEFAULT_MODEL, MODELS } from "@/lib/ai";
import { resolveAutoflowConfig, fetchDviWithCache } from "@/lib/integrations/autoflow";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";
import { logUsage, estimateCost } from "@/lib/usage";
import { trackApiRequest } from "@/lib/api-usage-tracker";

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

  return { ok: true as const, vin, squish: SQUISH, count: items.length, items };
}

export async function POST(req: NextRequest) {
  try {
    const { vin, shopId, model } = await req.json();
    if (!vin || !shopId) {
      return NextResponse.json({ ok: false, error: "vin and shopId are required" }, { status: 400 });
    }

    const chosenModel = MODELS.includes(model) ? model : DEFAULT_MODEL;

    const vehicleRows = await sql`
      SELECT year, make, model, last_mileage, odometer FROM vehicles 
      WHERE vin = ${String(vin).toUpperCase()} AND shop_id = ${String(shopId)}
    `;
    const vehicle = vehicleRows[0] as any;

    const currentMiles =
      (typeof vehicle?.last_mileage === "number" && vehicle.last_mileage > 0 && vehicle.last_mileage) ||
      (typeof vehicle?.odometer === "number" && vehicle.odometer > 0 && vehicle.odometer) ||
      null;

    const roRows = await sql`
      SELECT ro_number, status, mileage, updated_at, created_at FROM work_orders
      WHERE vin = ${String(vin).toUpperCase()} AND shop_id = ${String(shopId)}
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    `;
    const latestRoNumber = (roRows[0] as any)?.ro_number ?? null;

    const autoCfg = await resolveAutoflowConfig(Number(shopId));
    const dvi =
      latestRoNumber && autoCfg.configured
        ? await fetchDviWithCache(Number(shopId), String(latestRoNumber), 10 * 60 * 1000)
        : { ok: false, error: latestRoNumber ? "AutoFlow not connected." : "No RO found." };

    const carfaxCfg = await resolveCarfaxConfig(Number(shopId));
    const carfax = carfaxCfg.configured
      ? await fetchCarfaxWithCache(Number(shopId), String(vin).toUpperCase(), 7 * 24 * 60 * 60 * 1000)
      : { ok: false, error: "CARFAX not configured." as const };

    const oem = await getLocalOeFromPostgres(String(vin));

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
        { role: "user", content: "Based on this vehicle's DVI, CARFAX, and OEM schedule, list and prioritize all recommendations as JSON." },
        { role: "user", content: JSON.stringify(user) },
      ],
    });
    
    trackApiRequest('openai', '/chat/completions', 'POST', 200, Date.now() - startTime, Number(shopId)).catch(() => {});

    const raw = resp.choices?.[0]?.message?.content || "{}";
    let parsed: any = {};
    try { parsed = JSON.parse(raw); } catch { parsed = { parseError: true, raw }; }

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
