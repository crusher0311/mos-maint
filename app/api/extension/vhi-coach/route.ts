import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { rebuildVhi } from "@/lib/vhi-rebuild";
import { toKeyFromName, SERVICE_KEY_DISPLAY_NAMES } from "@/lib/service-keys";
import { computeIntervalProgress, type IntervalProgress } from "@/lib/vhi-progress";

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

interface TaskMatch {
  taskName: string;
  serviceKey: string | null;
  displayName: string | null;
  status: "overdue" | "due_soon" | "upcoming" | "ok" | "unknown";
  recommendation: string | null;
  /** Which interval axis triggered the status: "mileage", "time", "both", or null. */
  overdueBy: "mileage" | "time" | "both" | null;
  intervalMiles: number | null;
  intervalMonths: number | null;
  lastPerformedMiles: number | null;
  lastPerformedDate: string | null;
  dueAtMiles: number | null;
  dueAtDate: string | null;
  milesUntilDue: number | null;
  progress: IntervalProgress | null;
}

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const { vin, smsShopId, provider, inspectionTasks, mileage } = body;

  if (!vin || typeof vin !== "string" || vin.length !== 17) {
    return NextResponse.json(
      { error: "Valid 17-character VIN required" },
      { status: 400, headers: corsHeaders }
    );
  }

  if (!inspectionTasks || !Array.isArray(inspectionTasks) || inspectionTasks.length === 0) {
    return NextResponse.json(
      { error: "inspectionTasks array required" },
      { status: 400, headers: corsHeaders }
    );
  }

  const guard = await guardExtensionShopRequest(request, {
    smsShopId,
    provider,
    requiredFeatures: ["maintenance"],
    featureLabel: "VHI",
    corsHeaders,
  });
  if (!guard.ok) return guard.response;

  const resolvedShopId = guard.mosShopId;

  // VHI Coach is opt-in per shop. Default OFF until a shop owner enables it
  // from Settings → Extension Abilities. This prevents the overlay from
  // popping up for shops that have not been onboarded to the feature yet.
  const coachEnabled = Boolean(guard.shopDoc?.extensions?.vhiCoachEnabled);
  if (!coachEnabled) {
    return NextResponse.json(
      {
        success: false,
        disabled: true,
        error: "VHI Coach is disabled for this shop",
      },
      { headers: corsHeaders }
    );
  }

  const resolvedMileage = mileage ? Number(mileage) : null;

  if (!resolvedMileage || isNaN(resolvedMileage)) {
    return NextResponse.json(
      { error: "Valid mileage required for VHI analysis" },
      { status: 400, headers: corsHeaders }
    );
  }

  let vhi;
  try {
    vhi = await rebuildVhi(resolvedShopId, vin.toUpperCase(), resolvedMileage);
  } catch (err: any) {
    console.error("[VHI Coach] Error rebuilding VHI:", err.message);
    return NextResponse.json(
      { error: "Failed to generate VHI data" },
      { status: 500, headers: corsHeaders }
    );
  }

  if (!vhi.success || !vhi.buckets) {
    return NextResponse.json({
      success: false,
      error: vhi.error || "No VHI data available",
      vehicle: vhi.vehicle || null,
      score: vhi.score || null,
      taskMatches: [],
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

  const taskMatches: TaskMatch[] = inspectionTasks.map((taskName: string) => {
    const serviceKey = toKeyFromName(taskName);
    const match: TaskMatch = {
      taskName,
      serviceKey,
      displayName: serviceKey ? (SERVICE_KEY_DISPLAY_NAMES[serviceKey] || serviceKey) : null,
      status: "unknown",
      recommendation: null,
      overdueBy: null,
      intervalMiles: null,
      intervalMonths: null,
      lastPerformedMiles: null,
      lastPerformedDate: null,
      dueAtMiles: null,
      dueAtDate: null,
      milesUntilDue: null,
      progress: null,
    };

    if (!serviceKey) return match;

    const vhiItem = vhiByKey[serviceKey];
    if (!vhiItem) return match;

    match.status = vhiItem.status as any;
    match.intervalMiles = vhiItem.item.intervalMiles || null;
    match.intervalMonths = vhiItem.item.intervalMonths || null;
    match.lastPerformedMiles = vhiItem.item.lastMiles || null;
    match.lastPerformedDate = vhiItem.item.lastDate || null;
    match.dueAtMiles = vhiItem.item.dueAtMiles || null;
    match.dueAtDate = vhiItem.item.dueAtDate || null;

    if (resolvedMileage && vhiItem.item.dueAtMiles) {
      match.milesUntilDue = vhiItem.item.dueAtMiles - resolvedMileage;
    }

    // Compute progress + figure out which axis is driving the status so the
    // tech sees "overdue by mileage" / "by time" / "by both".
    const progress = computeIntervalProgress(
      {
        intervalMiles: vhiItem.item.intervalMiles ?? null,
        intervalMonths: vhiItem.item.intervalMonths ?? null,
        last: vhiItem.item.last ?? (vhiItem.item.lastMiles || vhiItem.item.lastDate
          ? { miles: vhiItem.item.lastMiles ?? null, date: vhiItem.item.lastDate ?? null }
          : null),
        dueAtMiles: vhiItem.item.dueAtMiles ?? null,
        dueAtDate: vhiItem.item.dueAtDate ?? null,
        milesToGo: vhiItem.item.milesToGo ?? null,
      },
      resolvedMileage || null
    );
    match.progress = progress;

    const milesOver = progress.miles.status === "overdue";
    const timeOver = progress.time.status === "overdue";
    const milesSoon = progress.miles.status === "soon";
    const timeSoon = progress.time.status === "soon";

    if (vhiItem.status === "overdue") {
      // Pick axis label
      let axis: "mileage" | "time" | "both" | null = null;
      if (milesOver && timeOver) axis = "both";
      else if (milesOver) axis = "mileage";
      else if (timeOver) axis = "time";
      match.overdueBy = axis;

      const milesPart = progress.miles.headline; // e.g. "1,247 mi over"
      const timePart = progress.time.headline; // e.g. "5 mos over"

      if (axis === "both" && milesPart && timePart) {
        match.recommendation = `OVERDUE by mileage AND time (${milesPart}, ${timePart}) — recommend immediate service`;
      } else if (axis === "mileage" && milesPart) {
        match.recommendation = `OVERDUE by mileage (${milesPart}) — recommend immediate service`;
      } else if (axis === "time" && timePart) {
        match.recommendation = `OVERDUE by time (${timePart}) — recommend immediate service`;
      } else {
        // Fallback when axis math couldn't be computed
        const overBy = match.milesUntilDue ? Math.abs(match.milesUntilDue) : null;
        match.recommendation = overBy
          ? `OVERDUE by ${overBy.toLocaleString()} miles — recommend immediate service`
          : `OVERDUE — recommend immediate service`;
      }
    } else if (vhiItem.status === "due_soon") {
      let axis: "mileage" | "time" | "both" | null = null;
      if (milesSoon && timeSoon) axis = "both";
      else if (milesSoon) axis = "mileage";
      else if (timeSoon) axis = "time";
      match.overdueBy = axis;

      const milesPart = progress.miles.headline; // "1,247 mi left"
      const timePart = progress.time.headline; // "28 days left"

      if (axis === "both" && milesPart && timePart) {
        match.recommendation = `Due soon by mileage AND time (${milesPart}, ${timePart})`;
      } else if (axis === "mileage" && milesPart) {
        match.recommendation = `Due soon by mileage (${milesPart})`;
      } else if (axis === "time" && timePart) {
        match.recommendation = `Due soon by time (${timePart})`;
      } else {
        const remaining = match.milesUntilDue || null;
        match.recommendation = remaining
          ? `Due soon — ${remaining.toLocaleString()} miles remaining`
          : `Due soon — recommend scheduling service`;
      }
    } else if (vhiItem.status === "upcoming") {
      const remaining = match.milesUntilDue || null;
      match.recommendation = remaining
        ? `OK — next service in ${remaining.toLocaleString()} miles`
        : `OK — not yet due`;
    }

    return match;
  });

  const matched = taskMatches.filter((t) => t.serviceKey !== null);
  const overdueCount = taskMatches.filter((t) => t.status === "overdue").length;
  const dueSoonCount = taskMatches.filter((t) => t.status === "due_soon").length;

  console.log(
    `[VHI Coach] ${vin} shop ${resolvedShopId}: ${matched.length}/${inspectionTasks.length} tasks matched, ${overdueCount} overdue, ${dueSoonCount} due soon`
  );

  return NextResponse.json({
    success: true,
    vin: vin.toUpperCase(),
    shopId: resolvedShopId,
    vehicle: vhi.vehicle,
    score: vhi.score,
    currentMiles: resolvedMileage,
    summary: {
      totalTasks: inspectionTasks.length,
      matched: matched.length,
      unmatched: inspectionTasks.length - matched.length,
      overdue: overdueCount,
      dueSoon: dueSoonCount,
      upcoming: taskMatches.filter((t) => t.status === "upcoming").length,
      ok: taskMatches.filter((t) => t.status === "ok").length,
    },
    taskMatches,
    vhiScore: vhi.score,
    vhiBuckets: vhi.summary,
  }, { headers: corsHeaders });
}
