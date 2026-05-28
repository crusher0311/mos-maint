import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { rebuildVhi } from "@/lib/vhi-rebuild";
import { SERVICE_KEY_DISPLAY_NAMES, toKeyFromName } from "@/lib/service-keys";
import { getDb } from "@/lib/mongo";
import { getDistanceLabel, getDistanceLabelFull, type DistanceUnit } from "@/lib/distance-utils";
import { isMiscServiceKey, formatLastDate } from "@/lib/vhi-text";

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

export const MARKER_PREFIX = "[VHI]";

function markerTagFor(_serviceKey: string) {
  return MARKER_PREFIX;
}

interface ProposedItem {
  serviceKey: string;
  title: string;
  status: "overdue" | "due_soon";
  milesUntilDue: number | null;
  markerTag: string;
  concern: string;
  job: {
    name: string;
    note: string | null;
    labor: Array<Record<string, unknown>>;
    parts: Array<Record<string, unknown>>;
    cannedJobSource: { id: string | number | null; name: string | null } | null;
  };
}

function sanitizeLaborLines(
  labor: any[],
  fallbackName: string,
): Array<Record<string, unknown>> {
  if (!Array.isArray(labor) || labor.length === 0) {
    return [{ name: fallbackName, hours: 0.5, autoApplyLaborMatrixId: null }];
  }
  return labor.map((l) => {
    const out: Record<string, unknown> = { ...l };
    out.autoApplyLaborMatrixId = null;
    delete out.id;
    delete out.tempId;
    delete out.jobId;
    return out;
  });
}

function sanitizePartsLines(parts: any[]): Array<Record<string, unknown>> {
  if (!Array.isArray(parts)) return [];
  return parts.map((p) => {
    const out: Record<string, unknown> = { ...p };
    delete out.id;
    delete out.tempId;
    delete out.jobId;
    return out;
  });
}

function buildProposedItem(
  item: any,
  status: "overdue" | "due_soon",
  currentMiles: number,
  cannedJobByKey: Map<string, any>,
  distanceUnit: DistanceUnit = "miles",
): ProposedItem | null {
  const serviceKey = item?.serviceKey;
  if (!serviceKey) return null;

  const displayName = SERVICE_KEY_DISPLAY_NAMES[serviceKey] || item.title || serviceKey;
  const tag = markerTagFor(serviceKey);
  const milesUntilDue = item.dueAtMiles != null ? item.dueAtMiles - currentMiles : null;
  const distLabel = getDistanceLabel(distanceUnit);
  const distLabelFull = getDistanceLabelFull(distanceUnit);

  let concernText: string;
  let noteText: string;
  // Misc items (serviceKey starts with "misc_") have unreliable dueAtMiles
  // — see isMiscServiceKey() comment. Suppress the mileage delta entirely
  // so the concern reads "OVERDUE. Recommend..." instead of nonsense like
  // "OVERDUE by 78,111 miles." Same for due_soon.
  const isMisc = isMiscServiceKey(serviceKey);

  if (status === "overdue") {
    const overBy = !isMisc && milesUntilDue != null ? Math.abs(milesUntilDue) : null;
    concernText = overBy
      ? `${tag} ${displayName} — OVERDUE by ${overBy.toLocaleString()} ${distLabelFull}. Recommend immediate service.`
      : `${tag} ${displayName} — OVERDUE. Recommend immediate service.`;
    noteText = `Auto-suggested from VHI (overdue${overBy ? ` by ${overBy.toLocaleString()} ${distLabel}` : ""}).`;
  } else {
    const remaining = !isMisc && milesUntilDue && milesUntilDue > 0 ? milesUntilDue : null;
    concernText = remaining
      ? `${tag} ${displayName} — due soon, ${remaining.toLocaleString()} ${distLabelFull} remaining.`
      : `${tag} ${displayName} — due soon, recommend scheduling service.`;
    noteText = `Auto-suggested from VHI (due soon${remaining ? `, ${remaining.toLocaleString()} ${distLabel} remaining` : ""}).`;
  }

  if (item.last?.date) {
    // Format as "Aug 05, 2021" rather than ISO "2021-08-05T00:00:00.000Z"
    // or even bare "2021-08-05" — friendlier for advisors reading the
    // technician concern in Tekmetric.
    const lastDateStr = formatLastDate(item.last.date);
    let lastStr = ` Last Reported: ${lastDateStr}`;
    if (item.last.miles) lastStr += ` at ${Number(item.last.miles).toLocaleString()} ${distLabel}`;
    lastStr += ".";
    concernText += lastStr;
  }

  const cannedJob = cannedJobByKey.get(serviceKey);
  const labor = sanitizeLaborLines(cannedJob?.labor, displayName);
  const parts = sanitizePartsLines(cannedJob?.parts);
  const cannedJobSource = cannedJob
    ? { id: cannedJob.id ?? cannedJob.code ?? null, name: cannedJob.name || cannedJob.title || null }
    : null;

  if (cannedJob) {
    noteText += ` Pre-populated from canned job "${cannedJob.name || cannedJob.title || ""}".`;
  }

  return {
    serviceKey,
    title: displayName,
    status,
    milesUntilDue,
    markerTag: tag,
    concern: concernText,
    job: {
      name: `${tag} ${displayName}`,
      note: noteText,
      labor,
      parts,
      cannedJobSource,
    },
  };
}

/**
 * Look up cached canned jobs (Tekmetric or Protractor) and build a
 * service-key → canned job map using the same toKeyFromName mapper used
 * elsewhere in the canonical service layer. We use the cache directly to
 * avoid an extra HTTP hop; the canned-jobs route refreshes it.
 */
async function loadCannedJobsByServiceKey(
  mosShopId: number,
  provider: string,
  shopDoc: any,
): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  try {
    const db = await getDb();
    let cannedJobs: any[] = [];
    if (provider === "protractor") {
      const cached = await db
        .collection("protractor_canned_jobs_cache")
        .findOne({ shopId: mosShopId });
      cannedJobs = cached?.cannedJobs || [];
    } else {
      const tekmetricShopId = shopDoc?.tekmetric?.shopId || shopDoc?.tekmetricShopId;
      if (tekmetricShopId) {
        const cached = await db
          .collection("tekmetric_canned_jobs_cache")
          .findOne({ shopId: tekmetricShopId });
        cannedJobs = cached?.cannedJobs || [];
      }
    }

    for (const job of cannedJobs) {
      const name = job?.name || job?.title;
      if (!name) continue;
      const key = toKeyFromName(name);
      if (!key) continue;
      const existing = map.get(key);
      const incomingScore =
        (Array.isArray(job.parts) ? job.parts.length : 0) +
        (Array.isArray(job.labor) ? job.labor.length : 0);
      const existingScore = existing
        ? (Array.isArray(existing.parts) ? existing.parts.length : 0) +
          (Array.isArray(existing.labor) ? existing.labor.length : 0)
        : -1;
      if (!existing || incomingScore > existingScore) map.set(key, job);
    }
  } catch (err: any) {
    console.error("[Build RO from VHI] canned-job lookup failed:", err?.message);
  }
  return map;
}

async function _POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const { vin, smsShopId, provider, mileage, roId, vehicleId } = body;

  if (!vin || typeof vin !== "string" || vin.length !== 17) {
    return NextResponse.json({ error: "Valid 17-character VIN required" }, { status: 400, headers: corsHeaders });
  }

  const guard = await guardExtensionShopRequest(request, {
    smsShopId,
    provider,
    requiredFeatures: ["maintenance", "dvi_prefill"],
    featureLabel: "Build RO from VHI",
    corsHeaders,
  });
  if (!guard.ok) return guard.response;

  const resolvedShopId = guard.mosShopId;
  const resolvedMileage = mileage ? Number(mileage) : null;

  if (!resolvedMileage || isNaN(resolvedMileage)) {
    return NextResponse.json({ error: "Valid mileage required" }, { status: 400, headers: corsHeaders });
  }

  let vhi;
  try {
    vhi = await rebuildVhi(resolvedShopId, vin.toUpperCase(), resolvedMileage);
  } catch (err: any) {
    console.error("[Build RO from VHI] Error rebuilding VHI:", err.message);
    return NextResponse.json({ error: "Failed to generate VHI data" }, { status: 500, headers: corsHeaders });
  }

  if (!vhi.success || !vhi.buckets) {
    return NextResponse.json({
      success: false,
      error: vhi.error || "No VHI data available for this vehicle",
      proposed: [],
    }, { headers: corsHeaders });
  }

  const cannedJobByKey = await loadCannedJobsByServiceKey(
    resolvedShopId,
    guard.provider || provider || "tekmetric",
    guard.shopDoc,
  );

  // Task #340: localize "mi"/"miles" in user-facing concern + note text so
  // Canadian shops see km labels everywhere, matching the plan endpoint.
  const shopDistanceUnit: DistanceUnit =
    ((guard.shopDoc as any)?.preferences?.distanceUnit
      ?? (guard.shopDoc as any)?.settings?.distanceUnit
      ?? "miles") === "kilometers"
      ? "kilometers"
      : "miles";

  const proposed: ProposedItem[] = [];
  for (const item of vhi.buckets.overdue || []) {
    const p = buildProposedItem(item, "overdue", resolvedMileage, cannedJobByKey, shopDistanceUnit);
    if (p) proposed.push(p);
  }
  for (const item of vhi.buckets.dueSoon || []) {
    const p = buildProposedItem(item, "due_soon", resolvedMileage, cannedJobByKey, shopDistanceUnit);
    if (p) proposed.push(p);
  }

  const matchedFromCanned = proposed.filter(p => p.job.cannedJobSource).length;
  console.log(
    `[Build RO from VHI] ${vin} shop ${resolvedShopId} ro=${roId ?? "?"} veh=${vehicleId ?? "?"}: proposed ${proposed.length} items (${matchedFromCanned} matched canned jobs, ${(vhi.buckets.overdue || []).length} overdue, ${(vhi.buckets.dueSoon || []).length} due soon)`
  );

  return NextResponse.json({
    success: true,
    vin: vin.toUpperCase(),
    shopId: resolvedShopId,
    roId: roId ?? null,
    vehicleId: vehicleId ?? null,
    vehicle: vhi.vehicle,
    score: vhi.score,
    currentMiles: resolvedMileage,
    markerPrefix: MARKER_PREFIX,
    summary: {
      total: proposed.length,
      overdue: proposed.filter(p => p.status === "overdue").length,
      dueSoon: proposed.filter(p => p.status === "due_soon").length,
      matchedCannedJobs: matchedFromCanned,
    },
    proposed,
  }, { headers: corsHeaders });
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
