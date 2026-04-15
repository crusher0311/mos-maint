import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus, getUserShopIds } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { rebuildVhi } from "@/lib/vhi-rebuild";
import { toKeyFromName, SERVICE_KEY_DISPLAY_NAMES } from "@/lib/service-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TaskMatch {
  taskName: string;
  serviceKey: string | null;
  displayName: string | null;
  status: "overdue" | "due_soon" | "upcoming" | "ok" | "unknown";
  recommendation: string | null;
  intervalMiles: number | null;
  intervalMonths: number | null;
  lastPerformedMiles: number | null;
  lastPerformedDate: string | null;
  dueAtMiles: number | null;
  dueAtDate: string | null;
  milesUntilDue: number | null;
}

export async function POST(request: NextRequest) {
  const auth = await validateExtensionToken(request);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: getAuthErrorStatus(auth) }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { vin, smsShopId, provider, inspectionTasks, mileage } = body;

  if (!vin || typeof vin !== "string" || vin.length !== 17) {
    return NextResponse.json(
      { error: "Valid 17-character VIN required" },
      { status: 400 }
    );
  }

  if (!smsShopId) {
    return NextResponse.json(
      { error: "smsShopId required" },
      { status: 400 }
    );
  }

  if (!inspectionTasks || !Array.isArray(inspectionTasks) || inspectionTasks.length === 0) {
    return NextResponse.json(
      { error: "inspectionTasks array required" },
      { status: 400 }
    );
  }

  const isPlatformAdmin =
    auth.user.role === "platform_admin" || auth.user.isPlatformAdmin === true;
  const userShopIds = getUserShopIds(auth.user);

  const shopResult = await findShopBySmsId(String(smsShopId), {
    isPlatformAdmin,
    userShopIds,
    providerHint: provider || "tekmetric",
  });

  if (!shopResult) {
    return NextResponse.json(
      { error: `No shop found for SMS ID: ${smsShopId}` },
      { status: 404 }
    );
  }

  if (!isPlatformAdmin && !userShopIds.includes(String(shopResult.mosShopId))) {
    return NextResponse.json(
      { error: "Unauthorized shop access" },
      { status: 403 }
    );
  }

  const resolvedShopId = shopResult.mosShopId;
  const resolvedMileage = mileage ? Number(mileage) : null;

  if (!resolvedMileage || isNaN(resolvedMileage)) {
    return NextResponse.json(
      { error: "Valid mileage required for VHI analysis" },
      { status: 400 }
    );
  }

  let vhi;
  try {
    vhi = await rebuildVhi(resolvedShopId, vin.toUpperCase(), resolvedMileage);
  } catch (err: any) {
    console.error("[VHI Coach] Error rebuilding VHI:", err.message);
    return NextResponse.json(
      { error: "Failed to generate VHI data" },
      { status: 500 }
    );
  }

  if (!vhi.success || !vhi.buckets) {
    return NextResponse.json({
      success: false,
      error: vhi.error || "No VHI data available",
      vehicle: vhi.vehicle || null,
      score: vhi.score || null,
      taskMatches: [],
    });
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
      intervalMiles: null,
      intervalMonths: null,
      lastPerformedMiles: null,
      lastPerformedDate: null,
      dueAtMiles: null,
      dueAtDate: null,
      milesUntilDue: null,
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

    if (vhiItem.status === "overdue") {
      const overBy = match.milesUntilDue ? Math.abs(match.milesUntilDue) : null;
      match.recommendation = overBy
        ? `OVERDUE by ${overBy.toLocaleString()} miles — recommend immediate service`
        : `OVERDUE — recommend immediate service`;
    } else if (vhiItem.status === "due_soon") {
      const remaining = match.milesUntilDue || null;
      match.recommendation = remaining
        ? `Due soon — ${remaining.toLocaleString()} miles remaining`
        : `Due soon — recommend scheduling service`;
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
  });
}
