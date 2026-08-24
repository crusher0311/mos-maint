// Task #991 — Auto DVI: dashboard-session push. Protractor writes happen
// server-side (same package construction as the extension route). Tekmetric
// custom-job writes require the page session in the extension, so the
// dashboard returns a clear error for Tekmetric shops.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  isProtractorShop,
  recordAutoDviApplication,
} from "@/lib/data/repositories/auto-dvi";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { buildInspectionLineTitle, buildFindingsNote, appendRatingTag, buildVhiContextNote } from "@/lib/auto-dvi/compose";
import { pushInspectionPackageToProtractor } from "@/lib/auto-dvi/protractor-push";
import { buildRecommendedWorkPackages } from "@/lib/auto-dvi/recommended-work";
import { trackPushToRO } from "@/lib/extension-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PACKAGE_TITLE = "Vehicle Inspection (MOS Auto DVI)";
const MAX_LINES = 100;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const shopId = Number(session.shopId);
  const isPlatformAdmin = session.role === "platform_admin";
  const denied = await checkShopFeatureGate(shopId, ["auto_dvi"], {
    isPlatformAdmin,
    featureLabel: "Auto DVI",
  });
  if (denied) return denied;

  let body: {
    vin?: string;
    roNumber?: string;
    workOrderGuid?: string;
    items?: Array<{
      name?: string;
      serviceKey?: string | null;
      rating?: "green" | "yellow" | "red" | null;
      notes?: string | null;
      recommendation?: string | null;
      // Plan context from the generate response — auto-fills the native
      // inspection line's notes like the VHI shows.
      source?: "vhi" | "shop" | "recall";
      bucket?: "overdue" | "due_soon" | "upcoming" | null;
      action?: string | null;
      dueAtMiles?: number | null;
      milesToGo?: number | null;
      itemNotes?: string | null;
    }>;
    /** Overdue/due-soon plan items the user opted to also add as priced
     * recommended-work packages (client filters by bucket; toggle-gated). */
    recommendedItems?: Array<{ name?: string; serviceKey?: string | null }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const items = Array.isArray(body.items) ? body.items.filter((i) => i?.name && String(i.name).trim()) : [];
  if (items.length === 0) {
    return NextResponse.json({ error: "At least one inspection item is required" }, { status: 400 });
  }
  if (items.length > MAX_LINES) {
    return NextResponse.json({ error: `Too many items (max ${MAX_LINES})` }, { status: 400 });
  }

  const isProtractor = await isProtractorShop(shopId);
  if (!isProtractor) {
    return NextResponse.json(
      { error: "Writing the inspection to a Tekmetric RO requires the MOS extension (open the RO in Tekmetric and use the side panel)." },
      { status: 400 },
    );
  }

  const vinUpper = body.vin ? String(body.vin).toUpperCase() : null;
  const lineTitles = items.map((i) =>
    appendRatingTag(buildInspectionLineTitle(String(i.name), i.serviceKey ?? null), i.rating ?? null),
  );
  const findingsNote = buildFindingsNote(
    items.map((i) => ({
      name: String(i.name),
      rating: i.rating ?? null,
      notes: i.notes ?? null,
      recommendation: i.recommendation ?? null,
    })),
  );

  const recommendedInputs = (Array.isArray(body.recommendedItems) ? body.recommendedItems : [])
    .filter((i) => i?.name && String(i.name).trim())
    .slice(0, MAX_LINES)
    .map((i) => ({ name: String(i.name).trim(), serviceKey: i.serviceKey ?? null }));
  const recommendedWork =
    recommendedInputs.length > 0
      ? await buildRecommendedWorkPackages({ shopId, items: recommendedInputs })
      : null;

  const result = await pushInspectionPackageToProtractor({
    shopId,
    vin: vinUpper,
    roNumber: body.roNumber || null,
    workOrderGuid: body.workOrderGuid || null,
    packageTitle: PACKAGE_TITLE,
    lineTitles,
    note: findingsNote,
    extraPackages: recommendedWork?.packages.map((p) => ({ title: p.title, hours: p.hours, rate: p.rate })),
    // Native Protractor inspection-results write (§1.9.4).
    inspectionItems: items.map((i) => ({
      name: String(i.name),
      rating: i.rating ?? null,
      notes: i.notes ?? null,
      recommendation: i.recommendation ?? null,
      context: buildVhiContextNote({
        source: i.source === "shop" || i.source === "recall" ? i.source : "vhi",
        bucket: i.bucket ?? null,
        action: i.action ?? null,
        dueAtMiles: i.dueAtMiles ?? null,
        milesToGo: i.milesToGo ?? null,
        notes: i.itemNotes ?? null,
      }),
    })),
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, requiresManualEntry: result.requiresManualEntry },
      { status: result.status || 500 },
    );
  }

  try {
    await recordAutoDviApplication({
      shopId,
      vin: vinUpper,
      provider: "protractor",
      repairOrderId: result.workOrderGuid || null,
      itemCount: lineTitles.length,
      appliedBy: session.email || null,
      mode: "server_write",
    });
  } catch (err: any) {
    console.error("[AutoDVI dashboard push] application record failed (non-fatal):", err?.message);
  }
  trackPushToRO({
    shopId,
    userId: session.email || undefined,
    vin: vinUpper || undefined,
    jobTitle: PACKAGE_TITLE,
    jobSource: "auto_dvi" as any,
    repairOrderId: result.workOrderGuid,
  }).catch((err) => console.error("[AutoDVI dashboard push] Analytics failed:", err));

  return NextResponse.json({
    ok: true,
    workOrderId: result.workOrderGuid,
    lineCount: lineTitles.length,
    recommendedCount: recommendedWork?.packages.length || 0,
    inspectionResultsWritten: result.inspectionResultsWritten || false,
  });
}
