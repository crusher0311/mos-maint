import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { authorizePublicReport, overlayPublicReport, refreshPublicReport } from "@/lib/public-report-service";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { resolveShopDistanceUnit, type ShopDistanceDoc } from "@/lib/shop-distance-unit";
import { readCustomerMileage } from "@/lib/customer-mileage-store";
import {
  buildReportUrl,
} from "@/lib/report-share";
import { findLatestTekmetricWorkOrderByVinWithCustomerName } from "@/lib/data/repositories/tekmetric-work-orders";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { readInspectionResults } from "@/lib/data/repositories/auto-dvi";
import { canAccessShopFeature } from "@/lib/shop-feature-access";
import {
  findLatestCachedPlanDoc,
  getMaintenanceAnalysisDoc,
  getReportApprovedItemsDoc,
  findCachedWorkOrderCustomerName,
} from "@/lib/data/repositories/plan-cache-store";

const TOKEN_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ vin: string }> }
) {
  return withUpstreamTimeout(readReport(req, context), 10_000, "public report read",
    NextResponse.json({ error: "Report temporarily unavailable. Please try again." }, { status: 503 }));
}

async function readReport(
  req: NextRequest,
  { params }: { params: Promise<{ vin: string }> }
) {
  try {
    const vin = (await params).vin?.toUpperCase();
    const token = req.nextUrl.searchParams.get("token");

    if (!vin) {
      return NextResponse.json({ error: "Missing VIN" }, { status: 400 });
    }

    const scope = await authorizePublicReport(vin, token);
    if (!scope) return NextResponse.json({ error: "Invalid or expired report link" }, { status: 403 });
    const { shopId, entitlements } = scope;

    const db = await getDb();

    const shop = await db.collection("shops").findOne({
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
    });
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const cachedPlan = await findLatestCachedPlanDoc(Number(shopId), vin, db);

    if (!cachedPlan?.plan) {
      let mileage: number | null = null;
      const vehicleDoc = await db.collection("vehicles").findOne(
        { vin, shopId: { $in: [String(shopId), Number(shopId)] } },
        { projection: { currentMileage: 1, lastMileage: 1 } }
      );
      mileage = vehicleDoc?.currentMileage ?? vehicleDoc?.lastMileage ?? null;
      const customerAnchor = await readCustomerMileage(db, shopId, vin);
      if (customerAnchor?.distanceUnit === resolveShopDistanceUnit(shop as ShopDistanceDoc)) {
        mileage = Math.max(mileage || 0, customerAnchor.mileage);
      }

      if (!mileage) {
        const analysisDoc = await getMaintenanceAnalysisDoc(Number(shopId), vin, db);
        mileage = (analysisDoc?.mileageAtAnalysis as number | null | undefined) ?? null;
      }

      if (mileage) {
        void refreshPublicReport(db, shopId, vin, null, { currentMiles: mileage }, true)
          .catch(() => console.warn("[Public report] Initial refresh unavailable"));
        return NextResponse.json({ pending: true, message: "Preparing your vehicle report" },
          { status: 202, headers: { "Retry-After": "3", "Cache-Control": "no-store" } });
      }

      if (!cachedPlan?.plan) {
        return NextResponse.json({ error: "No plan found for this vehicle. Visit the Vehicle Health Indicator page first to generate a plan." }, { status: 404 });
      }
    }

    const unit = resolveShopDistanceUnit(shop as ShopDistanceDoc);
    const plan = await overlayPublicReport(db, shopId, vin, cachedPlan, unit);
    void refreshPublicReport(db, shopId, vin, cachedPlan, plan)
      .catch(() => console.warn("[Public report] Background refresh unavailable"));
    const buckets = plan.buckets || {};

    const approvedDoc = await getReportApprovedItemsDoc(Number(shopId), vin, db) as {
      approvedServiceKeys?: string[];
      updatedAt?: string | Date;
    } | null;
    const approvedServiceKeys: string[] = [];
    if (approvedDoc?.approvedServiceKeys?.length && approvedDoc.approvedServiceKeys.length > 0) {
      const ageMs = approvedDoc.updatedAt ? Date.now() - new Date(approvedDoc.updatedAt).getTime() : Infinity;
      if (ageMs < 7 * 24 * 60 * 60 * 1000) {
        approvedServiceKeys.push(...approvedDoc.approvedServiceKeys);
      }
    }

    let customerName = plan.customerName || null;

    if (!customerName) {
      const tekWo = await findLatestTekmetricWorkOrderByVinWithCustomerName(
        String(shopId),
        vin,
      );
      if (tekWo?.customerName) customerName = tekWo.customerName;
    }

    if (!customerName) {
      const wo = await findCachedWorkOrderCustomerName(Number(shopId), vin, db);
      if (wo?.customerName) customerName = wo.customerName;
    }

    if (!customerName) {
      const vehicle = await db.collection("vehicles").findOne(
        {
          vin,
          shopId: { $in: [String(shopId), Number(shopId)] },
          customerName: { $exists: true, $nin: [null, ""] },
        },
        { projection: { customerName: 1 } }
      );
      if (vehicle?.customerName) customerName = vehicle.customerName;
    }

    // Shop's distance preference — propagate to the customer VHR so km-shops
    // (CA / metric) render "km" instead of hardcoded "mi". Triage at build
    // time already converted OEM miles → shop unit (Task #333), so the
    // numbers stored in `buckets` are in `distanceUnit` already; we just
    // need to label them correctly here.
    const distanceUnit = unit;

    // Task #991 — customer-facing DVI tab: when the shop has Auto DVI and
    // technicians recorded findings for this vehicle, include them so the
    // shared report can render an "Inspection" tab. Best-effort: any failure
    // here just omits the tab, never breaks the report.
    let dvi: any = undefined;
    try {
      if (entitlements.effectiveFeatures?.auto_dvi) {
        const results = await readInspectionResults(Number(shopId), vin);
        const withFindings = (results?.items || []).filter(
          (it) => it.rating || (it.notes || "").trim() || (it.recommendation || "").trim() || (it.media || []).length > 0,
        );
        if (withFindings.length > 0) {
          dvi = {
            updatedAt: results?.updatedAt ?? null,
            items: withFindings.map((it) => ({
              itemId: it.itemId,
              name: it.name,
              rating: it.rating ?? null,
              notes: it.notes ?? null,
              recommendation: it.recommendation ?? null,
              media: (it.media || []).map((m) => ({
                mediaId: m.mediaId,
                kind: m.kind,
                contentType: m.contentType,
              })),
            })),
          };
        }
      }
    } catch (err: any) {
      console.warn("[Report API] DVI block skipped:", err?.message);
    }

    return NextResponse.json({
      plan: {
        vehicle: plan.vehicle || {},
        vin,
        currentMiles: plan.currentMiles || cachedPlan.mileage || 0,
        mileageEstimated: !!plan.mileageEstimated,
        mileageInputSource: plan.mileageInputSource,
        customerName: customerName || "Vehicle Owner",
        distanceUnit,
        buckets: {
          overdue: buckets.overdue || [],
          dueSoon: buckets.dueSoon || [],
          upcoming: buckets.upcoming || [],
        },
        approvedServiceKeys: approvedServiceKeys.length > 0 ? approvedServiceKeys : undefined,
        // Task #439: forward data-quality so the report page can render
        // a gray "Insufficient History" badge instead of red 0/CRITICAL
        // when CARFAX + shop history give us nothing to anchor against.
        dataQuality: plan.dataQuality ?? undefined,
        dvi,
      },
      shopName: shop.name || shop.shopName || "",
      shopPhone: shop.phone || shop.contact?.phone || "",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: any) {
    console.error("[Report API] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ vin: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const vin = (await params).vin?.toUpperCase();
    const shopId = session.shopId;

    if (!vin || !shopId) {
      return NextResponse.json({ error: "Missing vin or shopId" }, { status: 400 });
    }
    const entitlements = await getFeatureEntitlements(Number(shopId));
    if (!canAccessShopFeature(session, entitlements, "maintenance")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
    }

    const expiresAt = Date.now() + TOKEN_MAX_AGE_MS;
    const shareUrl = buildReportUrl(vin, String(shopId), expiresAt);
    const token = new URL(shareUrl).searchParams.get("token");
    if (!token) {
      throw new Error("Generated report URL is missing its share token");
    }

    return NextResponse.json({
      shareUrl,
      token,
      expiresAt,
      expiresIn: "15 days",
    });
  } catch (err: any) {
    console.error("[Report API] Error generating share link:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
