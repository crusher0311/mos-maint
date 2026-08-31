import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-vehicle Normal vs Severe duty toggle for engine-oil interval
 * selection (Task #166). Persisted on the `vehicles` collection so the
 * preference is sticky across plan rebuilds.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ vin: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entitlements = await getFeatureEntitlements(Number(session.shopId));
  if (!canAccessShopFeature(session, entitlements, "maintenance")) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
  }

  const { vin } = await params;
  const db = await getDb();
  const vehicle = await db.collection("vehicles").findOne(
    {
      $or: [{ shopId: String(session.shopId) }, { shopId: Number(session.shopId) }],
      vin: vin.toUpperCase(),
    },
    { projection: { oilDutyPreference: 1 } },
  );

  return NextResponse.json({
    ok: true,
    oilDutyPreference: vehicle?.oilDutyPreference === "normal" ? "normal" : "severe",
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ vin: string }> },
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const entitlements = await getFeatureEntitlements(Number(session.shopId));
  if (!canAccessShopFeature(session, entitlements, "maintenance")) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
  }

  const { vin } = await params;
  const body = await req.json();
  const oilDutyPreference =
    body.oilDutyPreference === "normal" ? "normal" : "severe";

  const db = await getDb();
  const result = await db.collection("vehicles").updateOne(
    {
      $or: [{ shopId: String(session.shopId) }, { shopId: Number(session.shopId) }],
      vin: vin.toUpperCase(),
    },
    {
      $set: {
        oilDutyPreference,
        updatedAt: new Date(),
      },
    },
  );

  if (result.matchedCount === 0) {
    return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
  }

  // Bust any cached plan for this VIN so the next page load reflects the
  // newly selected duty schedule (oil interval, engine-risk chip, and the
  // auto-inserted Safety Check item all depend on it).
  // Task #998: clears BOTH stores (Mongo + PG) via the facade.
  const { deleteCachedPlans } = await import(
    "@/lib/data/repositories/plan-cache-store"
  );
  await deleteCachedPlans(Number(session.shopId), vin, db);

  return NextResponse.json({ ok: true, oilDutyPreference });
}
