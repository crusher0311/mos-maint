import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession, isPasswordChangeRequiredError } from "@/lib/auth";
import { setShopCarfaxLocationId } from "@/lib/integrations/carfax";
import { invalidateShopPlanCache } from "@/lib/plan-cache";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiError(status: number, code: string, error: string) {
  return NextResponse.json({ ok: false, code, error }, { status });
}

function failure(error: unknown) {
  if (isPasswordChangeRequiredError(error)) {
    return apiError(403, "PASSWORD_CHANGE_REQUIRED", "Change your password before managing CARFAX settings.");
  }
  if (error instanceof Response) return error;
  return apiError(500, "SETTINGS_UNAVAILABLE", "CARFAX settings could not be confirmed. Reload settings before trying again.");
}

async function requireSettingsSession() {
  const session = await getSession();
  if (!session) throw apiError(401, "SESSION_REQUIRED", "Your session has expired. Sign in again to manage CARFAX settings.");
  if (!Number.isSafeInteger(Number(session.shopId)) || Number(session.shopId) <= 0) {
    throw apiError(403, "SHOP_REQUIRED", "Select an authorized shop before managing CARFAX settings.");
  }
  const entitlements = await getFeatureEntitlements(Number(session.shopId));
  // Configuration is allowed independently of Maintenance. This does not
  // grant access to history, plans, or paid CARFAX requests.
  return { ...session, maintenanceEnabled: canAccessShopFeature(session, entitlements, "maintenance") };
}

export async function GET() {
  try {
    const session = await requireSettingsSession();
    const shopId = Number(session.shopId);

    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { carfax: 1, carfaxLocationId: 1 } }
    );

    const hasUrl = Boolean(process.env.CARFAX_POST_URL);
    const hasPdi = Boolean(process.env.CARFAX_PDI);

    return NextResponse.json({
      locationId: shop?.carfax?.locationId || shop?.carfaxLocationId || "",
      envConfigured: hasUrl && hasPdi,
      maintenanceEnabled: session.maintenanceEnabled,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e: any) {
    return failure(e);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSettingsSession();
    const shopId = Number(session.shopId);
    const body = await req.json().catch(() => { throw apiError(400, "INVALID_LOCATION_ID", "Enter a CARFAX Location ID."); });
    const { locationId } = body || {};
    if (typeof locationId !== "string" || !locationId.trim() || locationId.length > 256 || /[\u0000-\u001f\u007f]/.test(locationId)) {
      return apiError(400, "INVALID_LOCATION_ID", "Enter a CARFAX Location ID (up to 256 characters).");
    }

    const db = await getDb();
    const { cleared } = await setShopCarfaxLocationId(db, shopId, locationId);

    return NextResponse.json({ ok: true, locationId: locationId.trim(), maintenanceEnabled: session.maintenanceEnabled, cacheCleared: cleared });
  } catch (e: any) {
    return failure(e);
  }
}

export async function DELETE() {
  try {
    const session = await requireSettingsSession();
    const shopId = Number(session.shopId);

    const db = await getDb();
    const existing = await db
      .collection("shops")
      .findOne({ shopId }, { projection: { carfax: 1, carfaxLocationId: 1 } });
    const prevLoc = String(
      existing?.carfax?.locationId || existing?.carfaxLocationId || "",
    ).trim();

    await db.collection("shops").updateOne(
      { shopId },
      {
        $unset: {
          carfax: "",
          carfaxLocationId: "",
        },
        $set: { updatedAt: new Date() },
      }
    );

    // Standardize all CARFAX config transitions: removing CARFAX makes plans
    // that were built WITH service history stale, so clear them too so they
    // rebuild without CARFAX on next view.
    let cleared = null;
    if (prevLoc) {
      cleared = await invalidateShopPlanCache(db, shopId);
    }

    return NextResponse.json({ ok: true, cacheCleared: cleared });
  } catch (e: any) {
    return failure(e);
  }
}
