// lib/evidence.ts
import { getDb } from "@/lib/mongo";

export async function buildEvidenceForVIN(vin: string) {
  const db = await getDb();

  // Pull DVI items (Autoflow)
  const dvi = await db.collection("autoflow_dvi_items")
    .find({ vin }, { projection: { _id: 0 } }).limit(500).toArray();

  // Pull CARFAX history (your cached table)
  const carfax = await db.collection("carfax_history")
    .find({ vin }, { projection: { _id: 0 } }).limit(1000).toArray();

  // Pull OE schedule (DataOne LKP/DEF tables you imported)
  const veh = await db.collection("vehicles").findOne({ vin });
  const ymmFilter: any = { Year: veh?.year, Make: veh?.make, Model: veh?.model };
  if (veh?.trim) ymmFilter.Trim = veh.trim;

  const intervals = await db.collection("lkp_ymm_maintenance_interval")
    .find(ymmFilter, { projection: { _id: 0 } }).limit(5000).toArray();

  const defs = await db.collection("def_maintenance_event")
    .find({}, { projection: { _id: 0, EventCode: 1, Description: 1 } }).toArray();
  const defMap = new Map(defs.map(d => [String(d.EventCode), String(d.Description)]));

  const oe_schedule = intervals.map((r: any) => ({
    id: String(r.EventCode ?? r.ServiceCode ?? r._id ?? ""),
    normalized_service: normalizeLabel(r.Description ?? defMap.get(String(r.EventCode)) ?? ""),
    mileage_interval: toNum(r.MileageInterval),
    time_interval_months: toNum(r.TimeIntervalMonths),
    first_due_miles: toNum(r.FirstDueMiles),
    first_due_months: toNum(r.FirstDueMonths),
    description: String(r.Description ?? defMap.get(String(r.EventCode)) ?? ""),
    oem_notes: r.OemNotes ? String(r.OemNotes) : undefined,
  }));

  const evidence = {
    vehicle: { vin, year: veh?.year, make: veh?.make, model: veh?.model, trim: veh?.trim },
    current_odometer_miles: veh?.odometer,
    last_known_mileage: latestMileage(carfax, dvi),
    last_record_date_iso: latestMileageDate(carfax, dvi),
    avg_daily_miles: 30,
    dvi: dvi.map((x: any) => ({
      id: String(x.itemId || x.dviId || x._id || ""),
      normalized_service: normalizeLabel(x.label || x.system || ""),
      label: String(x.label || x.system || ""),
      severity: (String(x.severity || "green").toLowerCase() as "red"|"yellow"|"green"),
      note: x.note || x.comment || undefined,
      metrics: x.metrics || undefined
    })),
    carfax: carfax.map((r: any) => ({
      id: String(r.id || r.date || r._id || ""),
      date_iso: r.date_iso || r.date || "",
      mileage: toNum(r.mileage),
      service_label: String(r.service || r.label || ""),
      normalized_service: normalizeLabel(r.service || r.label || ""),
      note: r.shop || undefined
    })),
    oe_schedule
  };

  return evidence;
}

function toNum(v: any){ const n = Number(v); return Number.isFinite(n) ? n : undefined; }

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

function latestMileage(carfax: any[], dvi: any[]) {
  const all = [
    ...carfax.map(x => ({ m: Number(x.mileage)||0, d: new Date(x.date_iso||x.date||0).getTime()||0 })),
    ...dvi.map(x => ({ m: Number(x.mileage)||0, d: new Date(x.date_iso||x.date||0).getTime()||0 })),
  ];
  return all.sort((a,b)=>b.d-a.d)[0]?.m;
}
function latestMileageDate(carfax: any[], dvi: any[]) {
  const all = [
    ...carfax.map(x => new Date(x.date_iso||x.date||0).toISOString()),
    ...dvi.map(x => new Date(x.date_iso||x.date||0).toISOString()),
  ].filter(Boolean);
  return all.sort().pop();
}
