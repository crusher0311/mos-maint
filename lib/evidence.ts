import sql from "@/lib/db/postgres";

export async function buildEvidenceForVIN(vin: string) {
  const vinUpper = vin.toUpperCase();

  const dvi = await sql`
    SELECT * FROM autoflow_dvi_items WHERE vin = ${vinUpper} LIMIT 500
  `;

  const carfax = await sql`
    SELECT * FROM carfax_history WHERE vin = ${vinUpper} LIMIT 1000
  `;

  const vehResult = await sql`
    SELECT * FROM vehicles WHERE vin = ${vinUpper} LIMIT 1
  `;
  const veh = vehResult[0];

  let intervals: Record<string, unknown>[] = [];
  if (veh?.year && veh?.make && veh?.model) {
    if (veh?.trim) {
      intervals = await sql`
        SELECT * FROM lkp_ymm_maintenance_interval 
        WHERE "Year" = ${veh.year} AND "Make" = ${veh.make} AND "Model" = ${veh.model} AND "Trim" = ${veh.trim}
        LIMIT 5000
      `;
    } else {
      intervals = await sql`
        SELECT * FROM lkp_ymm_maintenance_interval 
        WHERE "Year" = ${veh.year} AND "Make" = ${veh.make} AND "Model" = ${veh.model}
        LIMIT 5000
      `;
    }
  }

  const defs = await sql`
    SELECT "EventCode", "Description" FROM def_maintenance_event
  `;
  const defMap = new Map(defs.map((d: Record<string, unknown>) => [String(d.EventCode), String(d.Description)]));

  const oe_schedule = intervals.map((r: Record<string, unknown>) => ({
    id: String(r.EventCode ?? r.ServiceCode ?? r.id ?? ""),
    normalized_service: normalizeLabel(String(r.Description ?? defMap.get(String(r.EventCode)) ?? "")),
    mileage_interval: toNum(r.MileageInterval),
    time_interval_months: toNum(r.TimeIntervalMonths),
    first_due_miles: toNum(r.FirstDueMiles),
    first_due_months: toNum(r.FirstDueMonths),
    description: String(r.Description ?? defMap.get(String(r.EventCode)) ?? ""),
    oem_notes: r.OemNotes ? String(r.OemNotes) : undefined,
  }));

  const evidence = {
    vehicle: { vin: vinUpper, year: veh?.year, make: veh?.make, model: veh?.model, trim: veh?.trim },
    current_odometer_miles: veh?.odometer,
    last_known_mileage: latestMileage(carfax, dvi),
    last_record_date_iso: latestMileageDate(carfax, dvi),
    avg_daily_miles: 30,
    dvi: dvi.map((x: Record<string, unknown>) => ({
      id: String(x.item_id || x.dvi_id || x.id || ""),
      normalized_service: normalizeLabel(String(x.label || x.system || "")),
      label: String(x.label || x.system || ""),
      severity: (String(x.severity || "green").toLowerCase() as "red"|"yellow"|"green"),
      note: x.note || x.comment || undefined,
      metrics: x.metrics || undefined
    })),
    carfax: carfax.map((r: Record<string, unknown>) => ({
      id: String(r.id || r.date || ""),
      date_iso: String(r.date_iso || r.date || ""),
      mileage: toNum(r.mileage),
      service_label: String(r.service || r.label || ""),
      normalized_service: normalizeLabel(String(r.service || r.label || "")),
      note: r.shop || undefined
    })),
    oe_schedule
  };

  return evidence;
}

function toNum(v: unknown){ const n = Number(v); return Number.isFinite(n) ? n : undefined; }

function normalizeLabel(s: string): string {
  const t = s.toLowerCase();
  if (t.includes("engine oil")) return "engine_oil";
  if (t.includes("oil filter")) return "oil_filter";
  if (t.includes("cabin")) return "cabin_filter";
  if (t.includes("air filter")) return "air_filter";
  if (t.includes("coolant") || t.includes("antifreeze")) return "coolant";
  if (t.includes("brake fluid")) return "brake_fluid";
  if (t.includes("transmission")) return "transmission_service";
  if (t.includes("transfer case")) return "transfer_case_service";
  if (t.includes("front differential")) return "differential_service_front";
  if (t.includes("rear differential")) return "differential_service_rear";
  if (t.includes("spark plug")) return "spark_plugs";
  if (t.includes("serpentine")) return "serpentine_belt";
  if (t.includes("timing belt")) return "timing_belt";
  if (t.includes("pcv")) return "pcv";
  if (t.includes("throttle body")) return "throttle_body_clean";
  if (t.includes("fuel")) return "fuel_system_service";
  if (t.includes("battery")) return "battery";
  if (t.includes("brake") && t.includes("front")) return "brakes_front";
  if (t.includes("brake") && t.includes("rear")) return "brakes_rear";
  if (t.includes("tire")) return "tires";
  if (t.includes("align")) return "alignment";
  if (t.includes("wiper")) return "wipers";
  if (t.includes("hvac") || t.includes("a/c") || t.includes("air conditioning")) return "hvac";
  if (t.includes("suspension") || t.includes("steering")) return "steering_suspension";
  if (t.includes("driveline") || t.includes("driveshaft") || t.includes("u-joint")) return "driveline";
  if (t.includes("exhaust")) return "exhaust";
  if (t.includes("recall")) return "safety_recall";
  return "other";
}

function latestMileage(carfax: Record<string, unknown>[], dvi: Record<string, unknown>[]) {
  const all = [
    ...carfax.map(x => ({ m: Number(x.mileage)||0, d: new Date(String(x.date_iso||x.date||0)).getTime()||0 })),
    ...dvi.map(x => ({ m: Number(x.mileage)||0, d: new Date(String(x.date_iso||x.date||0)).getTime()||0 })),
  ];
  return all.sort((a,b)=>b.d-a.d)[0]?.m;
}

function latestMileageDate(carfax: Record<string, unknown>[], dvi: Record<string, unknown>[]) {
  const all = [
    ...carfax.map(x => new Date(String(x.date_iso||x.date||0)).toISOString()),
    ...dvi.map(x => new Date(String(x.date_iso||x.date||0)).toISOString()),
  ].filter(Boolean);
  return all.sort().pop();
}
