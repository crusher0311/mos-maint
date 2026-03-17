import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getCachedPlan } from "@/lib/plan-cache";
import { computeScore, getScoreTier, formatVhiItem, getVhiFromAnalysisCache } from "@/lib/vhi-score";
import { triggerPlanBuild } from "@/lib/vhi-rebuild";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { vin: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const vin = params.vin?.toUpperCase();

    if (!vin || vin.length !== 17) {
      return NextResponse.json(
        { error: "Valid 17-character VIN required" },
        { status: 400 }
      );
    }

    const db = await getDb();

    const vehicleDoc = await db.collection("vehicles").findOne(
      { shopId: { $in: [String(shopId), Number(shopId)] }, vin },
      { projection: { currentMileage: 1, lastMileage: 1 } }
    );

    const mileage = vehicleDoc?.currentMileage ?? vehicleDoc?.lastMileage ?? null;

    let cached = await getCachedPlan(db, vin, shopId, mileage);

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

    console.log(`[VHI API] No cached_plans entry for ${vin} at shop ${shopId}, checking analysis cache...`);
    const analysisResult = await getVhiFromAnalysisCache(db, vin, shopId, mileage);

    if (analysisResult) {
      console.log(`[VHI API] Found analysis cache for ${vin} at shop ${shopId}`);
      return NextResponse.json({
        success: true,
        vin,
        ...analysisResult,
        source: "analysis_cache",
      });
    }

    if (mileage) {
      console.log(`[VHI API] No cache at all for ${vin} at shop ${shopId}, triggering build...`);
      const built = await triggerPlanBuild(shopId, vin, mileage);
      if (built) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        cached = await getCachedPlan(db, vin, shopId, mileage);
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
        message: "No maintenance plan has been built for this vehicle yet. Trigger a plan build first by viewing the vehicle's plan page or calling POST /api/plan-build?vin=VIN&mileage=MILEAGE.",
      },
      { status: 404 }
    );
  } catch (err: any) {
    console.error("[VHI API] Error:", err);
    return NextResponse.json(
      { error: "Failed to retrieve VHI data" },
      { status: 500 }
    );
  }
}
