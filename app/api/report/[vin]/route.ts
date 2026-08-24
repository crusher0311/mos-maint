import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { triggerPlanBuild } from "@/lib/vhi-rebuild";
import { generateShareToken, verifyShareToken } from "@/lib/report-share";
import { findLatestTekmetricWorkOrderByVinWithCustomerName } from "@/lib/data/repositories/tekmetric-work-orders";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { readInspectionResults } from "@/lib/data/repositories/auto-dvi";

const TOKEN_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;

export async function GET(
  req: NextRequest,
  { params }: { params: { vin: string } }
) {
  try {
    const vin = params.vin?.toUpperCase();
    const token = req.nextUrl.searchParams.get("token");

    if (!vin) {
      return NextResponse.json({ error: "Missing VIN" }, { status: 400 });
    }

    let shopId: string | null = null;

    if (token) {
      const verified = verifyShareToken(token);
      if (!verified || verified.vin !== vin) {
        return NextResponse.json({ error: "Invalid or expired report link" }, { status: 403 });
      }
      shopId = verified.shopId;
    } else {
      return NextResponse.json({ error: "A valid share link is required to view this report" }, { status: 403 });
    }

    const db = await getDb();

    const shop = await db.collection("shops").findOne({
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
    });
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    // Task #998: flag-dispatched PG/Mongo facade reads.
    const {
      findLatestCachedPlanDoc,
      getMaintenanceAnalysisDoc,
      getReportApprovedItemsDoc,
      findCachedWorkOrderCustomerName,
    } = await import("@/lib/data/repositories/plan-cache-store");

    let cachedPlan = await findLatestCachedPlanDoc(Number(shopId), vin, db);

    if (!cachedPlan?.plan) {
      let mileage: number | null = null;
      const vehicleDoc = await db.collection("vehicles").findOne(
        { vin, shopId: { $in: [String(shopId), Number(shopId)] } },
        { projection: { currentMileage: 1, lastMileage: 1 } }
      );
      mileage = vehicleDoc?.currentMileage ?? vehicleDoc?.lastMileage ?? null;

      if (!mileage) {
        const analysisDoc = await getMaintenanceAnalysisDoc(Number(shopId), vin, db);
        mileage = (analysisDoc?.mileageAtAnalysis as number | null | undefined) ?? null;
      }

      if (mileage) {
        console.log(`[Report API] No cached plan for ${vin}, triggering rebuild with mileage ${mileage}...`);
        const built = await triggerPlanBuild(Number(shopId), vin, mileage);
        if (built.ok) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          cachedPlan = await findLatestCachedPlanDoc(Number(shopId), vin, db);
        }
      }

      if (!cachedPlan?.plan) {
        return NextResponse.json({ error: "No plan found for this vehicle. Visit the Vehicle Health Indicator page first to generate a plan." }, { status: 404 });
      }
    }

    const plan = cachedPlan.plan as {
      buckets?: { overdue?: unknown[]; dueSoon?: unknown[]; upcoming?: unknown[] };
      customerName?: string | null;
      vehicle?: unknown;
      currentMiles?: number | null;
      dataQuality?: unknown;
    };
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
    const distanceUnit: "miles" | "kilometers" =
      shop?.preferences?.distanceUnit === "kilometers" ? "kilometers" : "miles";

    // Task #991 — customer-facing DVI tab: when the shop has Auto DVI and
    // technicians recorded findings for this vehicle, include them so the
    // shared report can render an "Inspection" tab. Best-effort: any failure
    // here just omits the tab, never breaks the report.
    let dvi: any = undefined;
    try {
      const entitlements = await getFeatureEntitlements(Number(shopId));
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
    });
  } catch (err: any) {
    console.error("[Report API] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { vin: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const vin = params.vin?.toUpperCase();
    const shopId = session.shopId;

    if (!vin || !shopId) {
      return NextResponse.json({ error: "Missing vin or shopId" }, { status: 400 });
    }

    const expiresAt = Date.now() + TOKEN_MAX_AGE_MS;
    const token = generateShareToken(vin, String(shopId), expiresAt);

    const host = req.headers.get("host") || req.nextUrl.host;
    const protocol = req.headers.get("x-forwarded-proto") || "https";
    const shareUrl = `${protocol}://${host}/report/${vin}?token=${token}`;

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
