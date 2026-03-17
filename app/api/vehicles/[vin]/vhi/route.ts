import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getCachedPlan, type TriagedItemCache } from "@/lib/plan-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function categoryMultiplier(category: string): number {
  const cat = (category || "").toLowerCase();
  if (cat.includes("brake") || cat.includes("tire") || cat.includes("steering") || cat.includes("suspension")) return 1.5;
  if (cat.includes("engine") || cat.includes("transmission") || cat.includes("drivetrain")) return 1.3;
  if (cat.includes("wiper") || cat.includes("light") || cat.includes("cabin") || cat.includes("body")) return 0.7;
  return 1.0;
}

function computeScore(buckets: { overdue: TriagedItemCache[]; dueSoon: TriagedItemCache[] }): number {
  let score = 100;

  for (const item of buckets.overdue) {
    let deduction = item.bump === "red" ? 7 : 5;
    deduction *= categoryMultiplier(item.category || "");
    if (item.declined) deduction += 1;
    score -= deduction;
  }

  for (const item of buckets.dueSoon) {
    let deduction = item.bump === "yellow" ? 2.5 : item.bump === "red" ? 3 : 2;
    deduction *= categoryMultiplier(item.category || "");
    score -= deduction;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function getScoreTier(score: number): { label: string; color: string } {
  if (score >= 90) return { label: "Excellent", color: "green" };
  if (score >= 80) return { label: "Good", color: "lime" };
  if (score >= 70) return { label: "Needs Attention", color: "amber" };
  if (score >= 60) return { label: "Poor", color: "orange" };
  return { label: "Critical", color: "red" };
}

function formatItem(item: TriagedItemCache) {
  return {
    key: item.key,
    serviceKey: item.serviceKey,
    title: item.title,
    category: item.category || null,
    intervalMiles: item.intervalMiles ?? null,
    intervalMonths: item.intervalMonths ?? null,
    last: item.last
      ? {
          miles: item.last.miles ?? null,
          date: item.last.date ?? null,
          source: item.last.source ?? null,
        }
      : null,
    dueAtMiles: item.dueAtMiles ?? null,
    dueAtDate: item.dueAtDate ?? null,
    milesToGo: item.milesToGo ?? null,
    daysToGo: item.daysToGo ?? null,
    bump: item.bump ?? null,
    source: item.source ?? null,
    dviSource: item.dviSource ?? null,
    declined: !!item.declined,
  };
}

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
      { shopId, vin },
      { projection: { currentMileage: 1, lastMileage: 1, year: 1, make: 1, model: 1 } }
    );

    const mileage = vehicleDoc?.currentMileage ?? vehicleDoc?.lastMileage ?? null;

    const cached = await getCachedPlan(db, vin, shopId, mileage);

    if (!cached) {
      return NextResponse.json(
        {
          error: "No VHI data available",
          message: "No maintenance plan has been built for this vehicle yet. Trigger a plan build first by viewing the vehicle's plan page or calling POST /api/plan-build?vin=VIN&mileage=MILEAGE.",
        },
        { status: 404 }
      );
    }

    const plan = cached.plan;
    const score = computeScore(plan.buckets);
    const tier = getScoreTier(score);

    return NextResponse.json({
      ok: true,
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
      score: {
        value: score,
        tier: tier.label,
        color: tier.color,
      },
      summary: {
        overdue: plan.buckets.overdue.length,
        dueSoon: plan.buckets.dueSoon.length,
        upcoming: plan.buckets.upcoming.length,
      },
      buckets: {
        overdue: plan.buckets.overdue.map(formatItem),
        dueSoon: plan.buckets.dueSoon.map(formatItem),
        upcoming: plan.buckets.upcoming.map(formatItem),
      },
      cachedAt: cached.createdAt,
    });
  } catch (err: any) {
    console.error("[VHI API] Error:", err);
    return NextResponse.json(
      { error: "Failed to retrieve VHI data" },
      { status: 500 }
    );
  }
}
