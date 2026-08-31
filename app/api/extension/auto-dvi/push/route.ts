// Task #991 — Auto DVI: push the confirmed inspection to the open work
// order as an "Inspection" package with one inspection-phrased line per
// item ("Inspected: …") so the posted RO carries CARFAX-visible evidence
// that the items were actually inspected — and never resets a
// replacement-interval clock (verb phrasing is enforced server-side via
// buildInspectionLineTitle regardless of what the client sends).
//
// Protractor: the server writes the ServicePackage directly (same
// construction as the add-to-RO route).
// Tekmetric: the public API has no arbitrary job-create endpoint, so —
// exactly like the add-declined-work flow — this route resolves the target
// RO and returns the composed job; the sidepanel executes the write via
// CREATE_TEKMETRIC_JOB using the page session, then confirms.

import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { AUTO_DVI_REQUIRED_FEATURES } from "@/lib/shop-feature-access";
import {
  recordAutoDviApplication,
  findOpenTekmetricRoIdByVin,
  type AutoDviApplicationRecord,
} from "@/lib/data/repositories/auto-dvi";
import { buildInspectionLineTitle, buildFindingsNote, appendRatingTag, buildVhiContextNote } from "@/lib/auto-dvi/compose";
import { buildRecommendedWorkPackages } from "@/lib/auto-dvi/recommended-work";
import { pushInspectionPackageToProtractor } from "@/lib/auto-dvi/protractor-push";
import { trackPushToRO } from "@/lib/extension-analytics";

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

const PACKAGE_TITLE = "Vehicle Inspection (MOS Auto DVI)";
const MAX_LINES = 100;

interface PushItem {
  name?: string;
  serviceKey?: string | null;
  rating?: "green" | "yellow" | "red" | null;
  notes?: string | null;
  recommendation?: string | null;
  // Plan context from the generate response — used to auto-fill the native
  // inspection line's notes like the VHI shows (bucket, action, mileage).
  source?: "vhi" | "shop" | "recall";
  bucket?: "overdue" | "due_soon" | "upcoming" | null;
  action?: string | null;
  dueAtMiles?: number | null;
  milesToGo?: number | null;
  itemNotes?: string | null;
}

async function recordApplication(opts: AutoDviApplicationRecord) {
  try {
    await recordAutoDviApplication(opts);
  } catch (err: any) {
    console.error("[AutoDVI push] application record failed (non-fatal):", err?.message);
  }
}

async function _POST(req: NextRequest) {
  try {
    let body: {
      shopId?: string | number;
      vin?: string;
      provider?: string;
      roNumber?: string;
      roId?: string | number;
      workOrderGuid?: string;
      items?: PushItem[];
      /** Overdue/due-soon plan items the user opted to also add as priced
       * recommended-work packages (client filters by bucket; toggle-gated). */
      recommendedItems?: Array<{ name?: string; serviceKey?: string | null }>;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
    }

    if (!body.shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    const items = Array.isArray(body.items) ? body.items.filter((i) => i?.name && String(i.name).trim()) : [];
    if (items.length === 0) {
      return NextResponse.json({ error: "At least one inspection item is required" }, { status: 400, headers: corsHeaders });
    }
    if (items.length > MAX_LINES) {
      return NextResponse.json({ error: `Too many items (max ${MAX_LINES})` }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: body.shopId,
      provider: body.provider || "tekmetric",
      requiredFeatures: AUTO_DVI_REQUIRED_FEATURES,
      featureLabel: "Auto DVI",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const vinUpper = body.vin ? String(body.vin).toUpperCase() : null;
    // Server-enforced inspection phrasing: never trust client titles for
    // the history-anchor safety property.
    // Yellow/red ratings ride on the line titles as bracketed tags
    // ("Inspected: Battery [Red]") — the tag words carry no performed-service
    // verbs so titles stay inspection-phrased for history-anchor safety.
    const lineTitles = items.map((i) =>
      appendRatingTag(buildInspectionLineTitle(String(i.name), i.serviceKey ?? null), i.rating ?? null),
    );
    const recommendedInputs = (Array.isArray(body.recommendedItems) ? body.recommendedItems : [])
      .filter((i) => i?.name && String(i.name).trim())
      .slice(0, MAX_LINES)
      .map((i) => ({ name: String(i.name).trim(), serviceKey: i.serviceKey ?? null }));
    const recommendedWork =
      recommendedInputs.length > 0
        ? await buildRecommendedWorkPackages({ shopId: guard.mosShopId, items: recommendedInputs })
        : null;

    // Notes/recommendations still go in the package note.
    const findingsNote = buildFindingsNote(
      items.map((i) => ({
        name: String(i.name),
        rating: i.rating ?? null,
        notes: i.notes ?? null,
        recommendation: i.recommendation ?? null,
      })),
    );

    if (guard.provider === "protractor") {
      const result = await pushInspectionPackageToProtractor({
        shopId: guard.mosShopId,
        vin: vinUpper,
        roNumber: body.roNumber || null,
        workOrderGuid: body.workOrderGuid || null,
        packageTitle: PACKAGE_TITLE,
        lineTitles,
        note: findingsNote,
        extraPackages: recommendedWork?.packages.map((p) => ({ title: p.title, hours: p.hours, rate: p.rate })),
        // Native Protractor inspection-results write (§1.9.4) — findings
        // land in Protractor's inspection view like a DVI provider's would.
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
          { status: result.status || 500, headers: corsHeaders },
        );
      }

      await recordApplication({
        shopId: guard.mosShopId,
        vin: vinUpper,
        provider: "protractor",
        repairOrderId: result.workOrderGuid || null,
        itemCount: lineTitles.length,
        appliedBy: guard.user?.email || null,
        mode: "server_write",
      });
      trackPushToRO({
        shopId: guard.mosShopId,
        userId: guard.user?.email || undefined,
        vin: vinUpper || undefined,
        jobTitle: PACKAGE_TITLE,
        jobSource: "auto_dvi" as any,
        repairOrderId: result.workOrderGuid,
      }).catch((err) => console.error("[AutoDVI push] Analytics failed:", err));

      return NextResponse.json(
        {
          ok: true,
          mode: "server_write",
          workOrderId: result.workOrderGuid,
          lineCount: lineTitles.length,
          recommendedCount: recommendedWork?.packages.length || 0,
          inspectionResultsWritten: result.inspectionResultsWritten || false,
        },
        { headers: corsHeaders },
      );
    }

    if (guard.provider === "tekmetric") {
      // Resolve the target RO like add-declined-work: explicit roId from the
      // panel context wins; otherwise newest non-terminal cached RO by VIN.
      let targetRoId: number | null = null;
      if (body.roId != null && String(body.roId).trim() !== "" && !isNaN(Number(body.roId))) {
        targetRoId = Number(body.roId);
      } else if (vinUpper) {
        targetRoId = await findOpenTekmetricRoIdByVin(guard.mosShopId, vinUpper);
      }
      if (!targetRoId) {
        return NextResponse.json(
          { error: "No open repair order found for this vehicle. Open the RO in Tekmetric first.", requiresManualEntry: true },
          { status: 404, headers: corsHeaders },
        );
      }

      await recordApplication({
        shopId: guard.mosShopId,
        vin: vinUpper,
        provider: "tekmetric",
        repairOrderId: String(targetRoId),
        itemCount: lineTitles.length,
        appliedBy: guard.user?.email || null,
        mode: "client_write",
      });
      trackPushToRO({
        shopId: guard.mosShopId,
        userId: guard.user?.email || undefined,
        vin: vinUpper || undefined,
        jobTitle: PACKAGE_TITLE,
        jobSource: "auto_dvi" as any,
        repairOrderId: String(targetRoId),
      }).catch((err) => console.error("[AutoDVI push] Analytics failed:", err));

      // The sidepanel performs the actual write via CREATE_TEKMETRIC_JOB
      // (page session) — one custom job, one 0-hour labor line per item.
      return NextResponse.json(
        {
          ok: true,
          mode: "client_write",
          repairOrderId: targetRoId,
          job: {
            name: PACKAGE_TITLE,
            laborItems: lineTitles.map((t) => ({ name: t, hours: 0 })),
            parts: [],
            note: findingsNote
              ? `Auto DVI — generated from VHI by MOS. ${findingsNote}`
              : "Auto DVI — generated from VHI by MOS",
          },
          // Priced recommended-work jobs (one per overdue/due-soon item the
          // user opted in) — the sidepanel writes each via CREATE_TEKMETRIC_JOB.
          recommendedJobs: (recommendedWork?.packages || []).map((p) => ({
            name: p.title,
            laborItems: [{ name: p.title, hours: p.hours, rate: p.rate }],
            parts: [],
            note: "Recommended from vehicle maintenance plan — MOS Auto DVI",
          })),
        },
        { headers: corsHeaders },
      );
    }

    return NextResponse.json(
      { error: `Auto DVI push is not supported for provider "${guard.provider}" yet` },
      { status: 400, headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[AutoDVI push] Error:", err?.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders });
  }
}

export const POST = withExtensionErrorMarker(_POST as any);
