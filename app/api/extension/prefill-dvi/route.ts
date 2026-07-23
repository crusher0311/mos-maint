import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { rebuildVhi } from "@/lib/vhi-rebuild";
import { toKeyFromName, SERVICE_KEY_DISPLAY_NAMES } from "@/lib/service-keys";
import { getDistanceLabel, getDistanceLabelFull, type DistanceUnit } from "@/lib/distance-utils";
import { isMiscServiceKey, formatLastDate } from "@/lib/vhi-text";
import { listRecentTekmetricWorkOrdersForVehicle } from "@/lib/data/repositories/tekmetric-work-orders";
import {
  detectRecentlyPerformed,
  extractPastInspectionFindings,
  isFindingRemedied,
  type PastInspectionFinding,
} from "@/lib/dvi-prefill-history";

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

const RATINGS = {
  CHCKD: { id: 1, code: "CHCKD", name: "Checked & Okay" },
  MAYRQRATTN: { id: 2, code: "MAYRQRATTN", name: "May Require Future Attention" },
  RQRSATTN: { id: 3, code: "RQRSATTN", name: "Requires Immediate Attention" },
  NA: { id: 4, code: "NA", name: "Not Applicable" },
};

interface TaskUpdate {
  taskId: number;
  taskName: string;
  inspectionGroup: string;
  serviceKey: string | null;
  rating: typeof RATINGS.CHCKD;
  finding: string | null;
  status: string;
  confidence: "high" | "medium" | "low";
  /**
   * Task #742: what the pre-fill is based on, so the tech (and any future UI)
   * can tell a concrete history/inspection signal apart from a generic VHI
   * interval projection:
   *   - "recently_performed" — CARFAX/shop history shows it was just done.
   *   - "inspection_history" — a real, unresolved prior inspection finding.
   *   - "vhi"                — interval-projected from the VHI buckets (default).
   */
  basis: "recently_performed" | "inspection_history" | "vhi";
}

async function _POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const { vin, smsShopId, provider, mileage, inspectionTasks } = body;

  if (!vin || typeof vin !== "string" || vin.length !== 17) {
    return NextResponse.json({ error: "Valid 17-character VIN required" }, { status: 400, headers: corsHeaders });
  }

  if (!inspectionTasks || !Array.isArray(inspectionTasks) || inspectionTasks.length === 0) {
    return NextResponse.json({ error: "inspectionTasks array required" }, { status: 400, headers: corsHeaders });
  }

  const guard = await guardExtensionShopRequest(request, {
    smsShopId,
    provider,
    requiredFeatures: ["maintenance", "dvi_prefill"],
    featureLabel: "DVI Pre-fill",
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
    console.error("[Prefill DVI] Error rebuilding VHI:", err.message);
    return NextResponse.json({ error: "Failed to generate VHI data" }, { status: 500, headers: corsHeaders });
  }

  if (!vhi.success || !vhi.buckets) {
    return NextResponse.json({
      success: false,
      error: vhi.error || "No VHI data available for this vehicle",
      updates: [],
    }, { headers: corsHeaders });
  }

  const vhiByKey: Record<string, { status: string; item: any }> = {};
  for (const item of vhi.buckets.overdue || []) {
    if (item.serviceKey) vhiByKey[item.serviceKey] = { status: "overdue", item };
  }
  for (const item of vhi.buckets.dueSoon || []) {
    if (item.serviceKey) vhiByKey[item.serviceKey] = { status: "due_soon", item };
  }
  for (const item of vhi.buckets.upcoming || []) {
    if (item.serviceKey) vhiByKey[item.serviceKey] = { status: "upcoming", item };
  }
  for (const item of vhi.buckets.complimentary || []) {
    if (item.serviceKey) vhiByKey[item.serviceKey] = { status: "ok", item };
  }

  // Task #340: respect shop distance preference in DVI finding text so the
  // tech sees "km" / "kilometers" (not "mi") for Canadian shops.
  const shopDistanceUnit: DistanceUnit =
    ((guard.shopDoc as any)?.preferences?.distanceUnit
      ?? (guard.shopDoc as any)?.settings?.distanceUnit
      ?? "miles") === "kilometers"
      ? "kilometers"
      : "miles";
  const distLabel = getDistanceLabel(shopDistanceUnit);
  const distLabelFull = getDistanceLabelFull(shopDistanceUnit);

  // Task #742: for Tekmetric, pull the vehicle's prior inspection findings so a
  // real, unresolved past finding can inform the pre-fill instead of a generic
  // VHI interval guess. No new upstream calls — this reads the already-synced
  // `tekmetric_work_orders` cache. Other providers (Protractor / Shop-Ware /
  // AutoFlow) degrade gracefully to VHI-only. Soft-fails so a Mongo hiccup
  // never breaks the pre-fill.
  const providerLower = String(provider || "").toLowerCase();
  const isTekmetric = providerLower
    ? providerLower === "tekmetric"
    : !!(guard.shopDoc as any)?.tekmetric?.shopId;
  let pastFindings = new Map<string, PastInspectionFinding>();
  if (isTekmetric) {
    try {
      const workOrders = await listRecentTekmetricWorkOrdersForVehicle(
        resolvedShopId,
        vin,
        50,
      );
      pastFindings = extractPastInspectionFindings(workOrders);
    } catch (err: any) {
      console.warn(`[Prefill DVI] past-inspection lookup failed for ${vin}: ${err?.message}`);
    }
  }

  const updates: TaskUpdate[] = [];
  // Task #897: record WHY each task was skipped so real-world DVI sheet
  // vocabulary gaps can be mined from production logs:
  //   - skippedNoServiceKey — the task name didn't resolve via toKeyFromName
  //     (a matcher vocabulary gap, the actionable kind).
  //   - skippedNoSignal — the name resolved to a key, but neither VHI nor a
  //     past inspection finding had anything to say about it.
  const skippedNoServiceKey: string[] = [];
  const skippedNoSignal: Array<{ taskName: string; serviceKey: string }> = [];

  for (const task of inspectionTasks) {
    const taskId = task.id;
    const taskName = task.name || task.taskName;
    const group = task.inspectionGroup || task.group || "";

    if (!taskId || !taskName) continue;

    const serviceKey = toKeyFromName(taskName);
    if (!serviceKey) {
      skippedNoServiceKey.push(taskName);
      continue;
    }

    const vhiItem = vhiByKey[serviceKey];
    const pastFinding = pastFindings.get(serviceKey);

    // Nothing to say about this task from either signal — skip it.
    if (!vhiItem && !pastFinding) {
      skippedNoSignal.push({ taskName, serviceKey });
      continue;
    }

    let rating = RATINGS.CHCKD;
    let finding: string | null = null;
    let confidence: "high" | "medium" | "low" = "medium";
    let status = vhiItem ? vhiItem.status : "ok";
    let basis: TaskUpdate["basis"] = "vhi";

    const displayName = SERVICE_KEY_DISPLAY_NAMES[serviceKey] || serviceKey;
    const lastAnchor = vhiItem?.item?.last ?? null;
    const milesUntilDue = vhiItem?.item?.dueAtMiles
      ? vhiItem.item.dueAtMiles - resolvedMileage
      : null;

    // Misc items have unreliable dueAtMiles — see isMiscServiceKey() in
    // lib/vhi-text. Suppress mileage deltas so findings don't read
    // "OVERDUE by 78,111 miles" for items where the due interval is
    // synthetic.
    const isMisc = isMiscServiceKey(serviceKey);

    // Helper: append the last-performed anchor to a VHI finding string.
    const withLastReported = (base: string): string => {
      let out = base;
      if (lastAnchor?.date) {
        out += ` Last Reported: ${formatLastDate(lastAnchor.date)}`;
        if (lastAnchor.miles) out += ` at ${Number(lastAnchor.miles).toLocaleString()} ${distLabel}`;
        out += ".";
      }
      return out;
    };

    // (1) Recently performed wins over everything: CARFAX/shop history shows
    // this service was just done, so it's Checked & Okay regardless of what the
    // interval math (or an old inspection) says. The anchor is already
    // inspect-vs-replace guarded by triage.
    const recent = detectRecentlyPerformed(lastAnchor, resolvedMileage);

    if (recent.performed) {
      rating = RATINGS.CHCKD;
      status = "ok";
      basis = "recently_performed";
      confidence = "high";
      let when = "";
      if (recent.date) when += ` on ${formatLastDate(recent.date)}`;
      if (recent.miles) when += ` at ${recent.miles.toLocaleString()} ${distLabel}`;
      finding = `[History] ${displayName} — recently performed${when}. No action needed.`;
    } else if (pastFinding && !isFindingRemedied(pastFinding, lastAnchor)) {
      // (2) A real, unresolved prior inspection finding beats a generic VHI
      // projection — the tech actually saw this on the vehicle.
      basis = "inspection_history";
      confidence = "high";
      const note = (pastFinding.finding || "").trim();
      const dateSuffix = pastFinding.date ? ` on ${formatLastDate(pastFinding.date)}` : " on file";
      if (pastFinding.rating === "bad") {
        rating = RATINGS.RQRSATTN;
        status = "overdue";
        finding = `[Inspection] ${displayName} — ${note || "flagged for immediate attention"} (from prior inspection${dateSuffix}).`;
      } else {
        rating = RATINGS.MAYRQRATTN;
        status = "due_soon";
        finding = `[Inspection] ${displayName} — ${note || "flagged to monitor"} (from prior inspection${dateSuffix}).`;
      }
    } else if (vhiItem && vhiItem.status === "overdue") {
      // (3) Generic VHI interval projection (unchanged behavior).
      rating = RATINGS.RQRSATTN;
      const overBy = !isMisc && milesUntilDue ? Math.abs(milesUntilDue) : null;
      finding = withLastReported(
        overBy
          ? `[VHI] ${displayName} — OVERDUE by ${overBy.toLocaleString()} ${distLabelFull}. Recommend immediate service.`
          : `[VHI] ${displayName} — OVERDUE. Recommend immediate service.`,
      );
      confidence = "high";
    } else if (vhiItem && vhiItem.status === "due_soon") {
      rating = RATINGS.MAYRQRATTN;
      const remaining = !isMisc && milesUntilDue ? milesUntilDue : null;
      finding = withLastReported(
        remaining
          ? `[VHI] ${displayName} — due soon, ${remaining.toLocaleString()} ${distLabelFull} remaining.`
          : `[VHI] ${displayName} — due soon, recommend scheduling service.`,
      );
      confidence = "high";
    } else {
      // upcoming / ok (or a task with only a remedied past finding).
      rating = RATINGS.CHCKD;
      status = "ok";
      const remaining = milesUntilDue || null;
      finding = remaining && remaining > 0
        ? `[VHI] ${displayName} — OK. Next service in ${remaining.toLocaleString()} ${distLabelFull}.`
        : `[VHI] ${displayName} — OK.`;
      confidence = "medium";
    }

    updates.push({
      taskId,
      taskName,
      inspectionGroup: group,
      serviceKey,
      rating,
      finding,
      status,
      confidence,
      basis,
    });
  }

  const overdueCount = updates.filter((u) => u.status === "overdue").length;
  const dueSoonCount = updates.filter((u) => u.status === "due_soon").length;
  const okCount = updates.filter((u) => u.status === "upcoming" || u.status === "ok").length;
  const skippedCount = skippedNoServiceKey.length + skippedNoSignal.length;

  console.log(
    `[Prefill DVI] ${vin} shop ${resolvedShopId}: ${updates.length} updates (${overdueCount} red, ${dueSoonCount} yellow, ${okCount} green), ${skippedCount} skipped`
  );
  // Task #897: mineable skip detail — one line per reason so production logs
  // expose the sheet vocabulary the matcher doesn't recognize yet.
  if (skippedNoServiceKey.length > 0) {
    console.log(
      `[Prefill DVI] ${vin} shop ${resolvedShopId}: ${skippedNoServiceKey.length} skipped (no service key): ${skippedNoServiceKey.join(" | ")}`
    );
  }
  if (skippedNoSignal.length > 0) {
    console.log(
      `[Prefill DVI] ${vin} shop ${resolvedShopId}: ${skippedNoSignal.length} skipped (no signal): ${skippedNoSignal.map((s) => `${s.taskName} → ${s.serviceKey}`).join(" | ")}`
    );
  }

  return NextResponse.json({
    success: true,
    vin: vin.toUpperCase(),
    shopId: resolvedShopId,
    vehicle: vhi.vehicle,
    score: vhi.score,
    currentMiles: resolvedMileage,
    summary: {
      totalTasks: inspectionTasks.length,
      updated: updates.length,
      skipped: skippedCount,
      overdue: overdueCount,
      dueSoon: dueSoonCount,
      ok: okCount,
    },
    // Task #897: skip diagnostics, split by reason (see loop above).
    skippedTasks: {
      noServiceKey: skippedNoServiceKey,
      noSignal: skippedNoSignal,
    },
    updates,
  }, { headers: corsHeaders });
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
