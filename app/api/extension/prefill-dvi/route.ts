import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus, getUserShopIds } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { rebuildVhi } from "@/lib/vhi-rebuild";
import { toKeyFromName, SERVICE_KEY_DISPLAY_NAMES } from "@/lib/service-keys";

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
}

export async function POST(request: NextRequest) {
  const auth = await validateExtensionToken(request);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      { error: auth.error || "Unauthorized" },
      { status: getAuthErrorStatus(auth), headers: corsHeaders }
    );
  }

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

  if (!smsShopId) {
    return NextResponse.json({ error: "smsShopId required" }, { status: 400, headers: corsHeaders });
  }

  if (!inspectionTasks || !Array.isArray(inspectionTasks) || inspectionTasks.length === 0) {
    return NextResponse.json({ error: "inspectionTasks array required" }, { status: 400, headers: corsHeaders });
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
    return NextResponse.json({ error: `No shop found for SMS ID: ${smsShopId}` }, { status: 404, headers: corsHeaders });
  }

  if (!isPlatformAdmin && !userShopIds.includes(String(shopResult.mosShopId))) {
    return NextResponse.json({ error: "Unauthorized shop access" }, { status: 403, headers: corsHeaders });
  }

  // Feature gate: requires both `maintenance` (VHI data source) and `dvi_prefill`.
  if (!isPlatformAdmin) {
    try {
      const entitlements = await getFeatureEntitlements(Number(shopResult.mosShopId));
      const eff = entitlements.effectiveFeatures;
      if (!eff.maintenance || !eff.dvi_prefill) {
        return NextResponse.json(
          { success: false, error: "DVI Pre-fill not enabled for this shop", code: "feature_disabled" },
          { status: 403, headers: corsHeaders }
        );
      }
    } catch (err: any) {
      console.error("[Prefill DVI] feature entitlement check failed:", err.message);
      return NextResponse.json(
        { success: false, error: "Unable to verify feature entitlement" },
        { status: 503, headers: corsHeaders }
      );
    }
  }

  const resolvedShopId = shopResult.mosShopId;
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

  const updates: TaskUpdate[] = [];
  let skippedCount = 0;

  for (const task of inspectionTasks) {
    const taskId = task.id;
    const taskName = task.name || task.taskName;
    const group = task.inspectionGroup || task.group || "";

    if (!taskId || !taskName) continue;

    const serviceKey = toKeyFromName(taskName);
    if (!serviceKey) {
      skippedCount++;
      continue;
    }

    const vhiItem = vhiByKey[serviceKey];
    if (!vhiItem) {
      skippedCount++;
      continue;
    }

    let rating = RATINGS.CHCKD;
    let finding: string | null = null;
    let confidence: "high" | "medium" | "low" = "medium";

    const displayName = SERVICE_KEY_DISPLAY_NAMES[serviceKey] || serviceKey;
    const milesUntilDue = vhiItem.item.dueAtMiles
      ? vhiItem.item.dueAtMiles - resolvedMileage
      : null;

    if (vhiItem.status === "overdue") {
      rating = RATINGS.RQRSATTN;
      const overBy = milesUntilDue ? Math.abs(milesUntilDue) : null;
      finding = overBy
        ? `[VHI] ${displayName} — OVERDUE by ${overBy.toLocaleString()} miles. Recommend immediate service.`
        : `[VHI] ${displayName} — OVERDUE. Recommend immediate service.`;
      if (vhiItem.item.lastDate) {
        finding += ` Last performed: ${vhiItem.item.lastDate}`;
        if (vhiItem.item.lastMiles) finding += ` at ${Number(vhiItem.item.lastMiles).toLocaleString()} mi`;
        finding += ".";
      }
      confidence = "high";
    } else if (vhiItem.status === "due_soon") {
      rating = RATINGS.MAYRQRATTN;
      const remaining = milesUntilDue || null;
      finding = remaining
        ? `[VHI] ${displayName} — due soon, ${remaining.toLocaleString()} miles remaining.`
        : `[VHI] ${displayName} — due soon, recommend scheduling service.`;
      if (vhiItem.item.lastDate) {
        finding += ` Last: ${vhiItem.item.lastDate}`;
        if (vhiItem.item.lastMiles) finding += ` at ${Number(vhiItem.item.lastMiles).toLocaleString()} mi`;
        finding += ".";
      }
      confidence = "high";
    } else if (vhiItem.status === "upcoming" || vhiItem.status === "ok") {
      rating = RATINGS.CHCKD;
      const remaining = milesUntilDue || null;
      finding = remaining && remaining > 0
        ? `[VHI] ${displayName} — OK. Next service in ${remaining.toLocaleString()} miles.`
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
      status: vhiItem.status,
      confidence,
    });
  }

  const overdueCount = updates.filter((u) => u.status === "overdue").length;
  const dueSoonCount = updates.filter((u) => u.status === "due_soon").length;
  const okCount = updates.filter((u) => u.status === "upcoming" || u.status === "ok").length;

  console.log(
    `[Prefill DVI] ${vin} shop ${resolvedShopId}: ${updates.length} updates (${overdueCount} red, ${dueSoonCount} yellow, ${okCount} green), ${skippedCount} skipped`
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
      updated: updates.length,
      skipped: skippedCount,
      overdue: overdueCount,
      dueSoon: dueSoonCount,
      ok: okCount,
    },
    updates,
  }, { headers: corsHeaders });
}
