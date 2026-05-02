import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";
import { getCachedPlan } from "@/lib/plan-cache";
import { computeScore, getScoreTier, formatVhiItem, getVhiFromAnalysisCache, separateComplimentary } from "@/lib/vhi-score";
import { getStatusIconSet } from "@/lib/vhi-icons";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { rebuildVhi } from "@/lib/vhi-rebuild";
import { buildReportUrl } from "@/lib/report-share";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createExternalEndpoint(
  "vehicles:read",
  async (req: NextRequest, { shopId, isPartner, partnerId, requestId }) => {
    const pathParts = req.nextUrl.pathname.split("/");
    const vinIndex = pathParts.indexOf("vehicles") + 1;
    const vin = pathParts[vinIndex]?.toUpperCase();

    if (!vin || vin.length !== 17) {
      return NextResponse.json(
        { error: "Valid 17-character VIN required" },
        { status: 400 }
      );
    }

    console.log(
      `[PartnerVHI] request_in requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
      `isPartner=${isPartner} apiKeyShopId=${shopId} vin=${vin}`
    );

    let resolvedShopId = shopId;

    if (isPartner) {
      const smsShopIdParam = req.nextUrl.searchParams.get("smsShopId");
      const smsParam = req.nextUrl.searchParams.get("sms");
      const shopIdParam = req.nextUrl.searchParams.get("shopId");

      if (shopIdParam) {
        const parsed = Number(shopIdParam);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return NextResponse.json(
            { error: "shopId must be a valid positive number" },
            { status: 400 }
          );
        }
        resolvedShopId = parsed;
      } else if (smsShopIdParam) {
        if (!smsParam) {
          return NextResponse.json(
            {
              error: "sms parameter required when using smsShopId",
              message: "Add &sms=tekmetric (or shopware, protractor, autoflow) to specify the SMS type",
            },
            { status: 400 }
          );
        }
        const shopResult = await findShopBySmsId(smsShopIdParam, {
          isPlatformAdmin: true,
          providerHint: smsParam.toLowerCase(),
        });
        if (!shopResult) {
          return NextResponse.json(
            { error: `No shop found for ${smsParam} ID: ${smsShopIdParam}` },
            { status: 404 }
          );
        }
        resolvedShopId = shopResult.mosShopId;
      } else {
        return NextResponse.json(
          {
            error: "Partner keys require shopId or smsShopId query parameter",
            message: "Add ?shopId=123 or ?smsShopId=456&sms=tekmetric to identify the shop",
          },
          { status: 400 }
        );
      }
    }

    const db = await getDb();

    const vehicleDoc = await db.collection("vehicles").findOne(
      {
        $or: [{ shopId: String(resolvedShopId) }, { shopId: Number(resolvedShopId) }],
        vin,
      },
      { projection: { currentMileage: 1, lastMileage: 1 } }
    );

    let mileage = vehicleDoc?.currentMileage ?? vehicleDoc?.lastMileage ?? null;

    let cached = await getCachedPlan(db, vin, resolvedShopId, mileage);

    if (cached) {
      const plan = cached.plan;
      const separated = separateComplimentary(plan.buckets);
      const score = computeScore(separated);
      const tier = getScoreTier(score);

      return NextResponse.json({
        success: true,
        vin,
        vehicle: {
          year: plan.vehicle.year ?? null,
          make: plan.vehicle.make ?? null,
          model: plan.vehicle.model ?? null,
          engine: plan.vehicle.engine ?? null,
        },
        currentMiles: plan.currentMiles,
        distanceUnit: plan.distanceUnit,
        customerName: plan.customerName ?? null,
        score: { value: score, tier: tier.label, color: tier.color },
        summary: {
          overdue: separated.overdue.length,
          dueSoon: separated.dueSoon.length,
          upcoming: separated.upcoming.length,
          complimentary: separated.complimentary.length,
        },
        buckets: {
          overdue: separated.overdue.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "overdue" })
          ),
          dueSoon: separated.dueSoon.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "dueSoon" })
          ),
          upcoming: separated.upcoming.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "upcoming" })
          ),
          complimentary: separated.complimentary.map((it) =>
            formatVhiItem(it, { currentMiles: plan.currentMiles, bucket: "complimentary" })
          ),
        },
        icons: getStatusIconSet(),
        reportUrl: buildReportUrl(vin, resolvedShopId),
        cachedAt: cached.createdAt,
        source: "cached_plan",
      });
    }

    console.log(`[VHI External] No cached_plans entry for ${vin} at shop ${resolvedShopId}, checking analysis cache...`);
    const analysisResult = await getVhiFromAnalysisCache(db, vin, resolvedShopId, mileage);

    if (analysisResult) {
      console.log(`[VHI External] Found analysis cache for ${vin} at shop ${resolvedShopId}`);
      return NextResponse.json({
        success: true,
        vin,
        ...analysisResult,
        icons: getStatusIconSet(),
        reportUrl: buildReportUrl(vin, resolvedShopId),
        source: "analysis_cache",
      });
    }

    if (!mileage) {
      const expiredEntry = await db.collection("cached_plans").findOne(
        { vin: vin.toUpperCase(), shopId: { $in: [String(resolvedShopId), Number(resolvedShopId)] } },
        { sort: { createdAt: -1 }, projection: { mileage: 1, "plan.currentMiles": 1 } }
      );
      if (expiredEntry) {
        mileage = expiredEntry.mileage || expiredEntry.plan?.currentMiles || null;
        console.log(`[VHI External] Recovered mileage ${mileage} from expired cache for ${vin}`);
      }
    }

    if (!mileage) {
      const analysisDoc = await db.collection("maintenance_analysis_cache").findOne(
        { vin: vin.toUpperCase(), shopId: { $in: [String(resolvedShopId), Number(resolvedShopId)] } },
        { projection: { mileageAtAnalysis: 1 } }
      );
      if (analysisDoc?.mileageAtAnalysis) {
        mileage = analysisDoc.mileageAtAnalysis;
        console.log(`[VHI External] Recovered mileage ${mileage} from analysis cache for ${vin}`);
      }
    }

    if (!mileage) {
      const shopDoc = await db.collection("shops").findOne(
        { shopId: { $in: [String(resolvedShopId), Number(resolvedShopId)] } },
        { projection: { integrationProvider: 1 } }
      );
      const provider = shopDoc?.integrationProvider || "tekmetric";

      if (provider === "tekmetric") {
        const wo = await db.collection("tekmetric_work_orders").findOne(
          { shopId: { $in: [String(resolvedShopId), Number(resolvedShopId)] }, vin: vin.toUpperCase() },
          { sort: { createdAt: -1 }, projection: { odometer: 1 } }
        );
        if (wo?.odometer) {
          mileage = wo.odometer;
          console.log(`[VHI External] Recovered mileage ${mileage} from tekmetric_work_orders for ${vin}`);
        }
      } else if (provider === "shopware") {
        const ro = await db.collection("shopware_repair_orders").findOne(
          { mosShopId: { $in: [String(resolvedShopId), Number(resolvedShopId)] }, vin: vin.toUpperCase() },
          { sort: { updatedAt: -1 }, projection: { odometer: 1, "raw.odometer": 1, "raw.odometer_out": 1 } }
        );
        if (ro) {
          mileage = ro?.raw?.odometer_out ?? ro?.raw?.odometer ?? ro?.odometer ?? null;
          if (mileage) console.log(`[VHI External] Recovered mileage ${mileage} from shopware_repair_orders for ${vin}`);
        }
      } else if (provider === "protractor") {
        const wo = await db.collection("protractor_work_orders").findOne(
          { shopId: { $in: [String(resolvedShopId), Number(resolvedShopId)] }, vin: vin.toUpperCase() },
          { sort: { updatedAt: -1 }, projection: { OutUsage: 1, InUsage: 1, Odometer: 1, "data.OutUsage": 1, "data.InUsage": 1, "data.Odometer": 1 } }
        );
        if (wo) {
          mileage = wo?.OutUsage ?? wo?.InUsage ?? wo?.Odometer ?? wo?.data?.OutUsage ?? wo?.data?.InUsage ?? wo?.data?.Odometer ?? null;
          if (mileage) console.log(`[VHI External] Recovered mileage ${mileage} from protractor_work_orders for ${vin}`);
        }
      }
    }

    if (!mileage || mileage <= 0) {
      return NextResponse.json(
        {
          success: false,
          error: "Could not determine mileage for this vehicle",
          message: "No mileage found in vehicle records, cached plans, or work orders. Provide mileage via the POST /api/external/vhi/analyze endpoint, or ensure the vehicle has a work order with an odometer reading.",
        },
        { status: 400 }
      );
    }

    console.log(
      `[PartnerVHI] rebuild_start requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
      `shopId=${resolvedShopId} vin=${vin} mileage=${mileage} isPartner=${isPartner}`
    );
    const result = await rebuildVhi(resolvedShopId, vin, mileage, { invalidateFirst: false });

    if (!result.success) {
      console.error(
        `[PartnerVHI] rebuild_failed requestId=${requestId} partnerId=${partnerId ?? "n/a"} ` +
        `shopId=${resolvedShopId} vin=${vin} mileage=${mileage} ` +
        `failedStage=${result.failedStage || "unknown"} upstreamStatus=${result.upstreamStatus ?? "n/a"} ` +
        `upstreamError=${typeof result.upstreamError === "string" ? result.upstreamError : JSON.stringify(result.upstreamError ?? null)}`
      );
      return NextResponse.json(
        {
          success: false,
          error: result.error || "Failed to build maintenance plan",
          failedStage: result.failedStage,
          upstreamStatus: result.upstreamStatus,
          upstreamError: result.upstreamError,
          requestId,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      vin,
      vehicle: result.vehicle,
      currentMiles: result.currentMiles,
      distanceUnit: result.distanceUnit,
      customerName: result.customerName,
      score: result.score,
      summary: result.summary,
      buckets: result.buckets,
      icons: getStatusIconSet(),
      reportUrl: buildReportUrl(vin, resolvedShopId),
      cachedAt: result.cachedAt,
      source: "on_demand_build",
    });
  }
);
