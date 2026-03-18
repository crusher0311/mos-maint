import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";
import { getCachedPlan } from "@/lib/plan-cache";
import { computeScore, getScoreTier, formatVhiItem, getVhiFromAnalysisCache } from "@/lib/vhi-score";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { triggerPlanBuild } from "@/lib/vhi-rebuild";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createExternalEndpoint(
  "vehicles:read",
  async (req: NextRequest, { shopId, isPartner }) => {
    const pathParts = req.nextUrl.pathname.split("/");
    const vinIndex = pathParts.indexOf("vehicles") + 1;
    const vin = pathParts[vinIndex]?.toUpperCase();

    if (!vin || vin.length !== 17) {
      return NextResponse.json(
        { error: "Valid 17-character VIN required" },
        { status: 400 }
      );
    }

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
      const score = computeScore(plan.buckets);
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
          overdue: plan.buckets.overdue.length,
          dueSoon: plan.buckets.dueSoon.length,
          upcoming: plan.buckets.upcoming.length,
        },
        buckets: {
          overdue: plan.buckets.overdue.map(formatVhiItem),
          dueSoon: plan.buckets.dueSoon.map(formatVhiItem),
          upcoming: plan.buckets.upcoming.map(formatVhiItem),
        },
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

    if (mileage) {
      console.log(`[VHI External] No valid cache for ${vin} at shop ${resolvedShopId}, triggering build with mileage ${mileage}...`);
      const built = await triggerPlanBuild(resolvedShopId, vin, mileage);
      if (built) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        cached = await getCachedPlan(db, vin, resolvedShopId, mileage);
        if (cached) {
          const plan = cached.plan;
          const score = computeScore(plan.buckets);
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
              overdue: plan.buckets.overdue.length,
              dueSoon: plan.buckets.dueSoon.length,
              upcoming: plan.buckets.upcoming.length,
            },
            buckets: {
              overdue: plan.buckets.overdue.map(formatVhiItem),
              dueSoon: plan.buckets.dueSoon.map(formatVhiItem),
              upcoming: plan.buckets.upcoming.map(formatVhiItem),
            },
            cachedAt: cached.createdAt,
            source: "fresh_build",
          });
        }
      }
    }

    return NextResponse.json(
      {
        error: "No VHI data available",
        message: "No maintenance plan has been built for this vehicle yet. The plan is built when the vehicle is viewed in the dashboard or Chrome extension.",
      },
      { status: 404 }
    );
  }
);
