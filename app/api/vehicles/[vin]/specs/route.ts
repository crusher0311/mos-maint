import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getVehicleSpecsLocal, decodeVinLocal, pingDataOne, type DecodeHint } from "@/lib/integrations/dataone-local";
import { deriveFuelTypeLabel } from "@/lib/fuel-type-label";
import { getCarfaxDecodeHint } from "@/lib/integrations/carfax";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { canAccessShopFeature } from "@/lib/shop-feature-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Specs are static per vehicle — cache the fully-resolved response for a long
// time (task #901). A resolved-hint row (`hint|<VIN>`) is stored alongside so
// the CARFAX disambiguation lookup happens at most once per vehicle.
const SPECS_CACHE_TTL_DAYS = 30;
const HINT_CACHE_TTL_DAYS = 90;
const DATAONE_PING_BUDGET_MS = 2500;

const emptyGrouped = {
  weightsAndCapacities: {},
  wheelsAndTires: {},
  brakes: {},
  dimensions: {},
  truckSpecs: {},
  seating: {},
  interior: {},
};

/** Stable, normalized key for the caller-provided disambiguation hints. */
function hintKeyOf(hint: DecodeHint): string {
  const parts: string[] = [];
  for (const field of ["trim", "subModel", "transmission", "transmissionType", "engineDescription"] as const) {
    const v = hint[field];
    if (v && String(v).trim().length > 0) {
      parts.push(`${field}=${String(v).trim().toLowerCase()}`);
    }
  }
  return parts.join("&");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ vin: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const entitlements = await getFeatureEntitlements(Number(session.shopId));
  if (!canAccessShopFeature(session, entitlements, "maintenance")) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
  }

  const { vin } = await params;
  const upperVin = vin.toUpperCase();

  // Optional disambiguation hints — caller passes the SMS vehicle's stored
  // trim/subModel/transmission so an ambiguous squish can resolve to one row.
  const sp = req.nextUrl.searchParams;
  const smsHint: DecodeHint = {
    trim: sp.get("trim"),
    subModel: sp.get("subModel"),
    transmission: sp.get("transmission"),
    transmissionType: sp.get("transmissionType"),
    engineDescription: sp.get("engine"),
  };
  const hasSmsHint = Object.values(smsHint).some((v) => v && String(v).trim().length > 0);
  const shopId = Number(session.shopId ?? 0);

  const cacheKey = `${upperVin}|${hintKeyOf(smsHint)}`;
  const hintRowKey = `hint|${upperVin}`;
  const now = new Date();

  // 1) Serve from the long-TTL specs cache — no DataOne / CARFAX touch at all.
  //    Cache failures must never break the route (fall through to live build).
  let cachedHintPayload: DecodeHint | null = null;
  try {
    const { pgFindVehicleSpecsCache } = await import("@/lib/db/repositories/wave1");
    const [cached, hintRow] = await Promise.all([
      pgFindVehicleSpecsCache(cacheKey),
      pgFindVehicleSpecsCache(hintRowKey),
    ]);
    if (cached && cached.expiresAt > now && cached.payload) {
      return NextResponse.json({ ...(cached.payload as object), cached: true });
    }
    if (hintRow && hintRow.expiresAt > now && hintRow.payload) {
      cachedHintPayload = hintRow.payload as DecodeHint;
    }
  } catch (cacheErr) {
    console.warn("[Specs] cache lookup failed, building live:", cacheErr);
  }

  // 2) Cache miss — the DataOne Postgres is about to be hit. If its endpoint
  //    has idled, the wake-up loop can block 6+ seconds; instead of hanging
  //    silently, bound the wait and tell the client to retry shortly while
  //    the wake-up continues in the background.
  const awake = await pingDataOne(DATAONE_PING_BUDGET_MS);
  if (!awake) {
    return NextResponse.json(
      {
        ok: false,
        vin: upperVin,
        specs: [],
        vehicleInfo: null,
        grouped: emptyGrouped,
        warming: true,
        retryAfterMs: 3000,
        error: "Vehicle data source is warming up — retrying shortly",
      },
      { status: 503, headers: { "Retry-After": "3" } }
    );
  }

  try {
    const pick = (a: string | null | undefined, b: string | null | undefined) =>
      (a && a.trim()) ? a : (b && b.trim() ? b : null);

    // SMS hint wins per-field; a previously-resolved (CARFAX-derived) hint
    // fills the gaps so the double-decode + CARFAX call happen at most once
    // per vehicle.
    let activeHint: DecodeHint | undefined = undefined;
    if (hasSmsHint || cachedHintPayload) {
      activeHint = {
        trim: pick(smsHint.trim, cachedHintPayload?.trim),
        subModel: pick(smsHint.subModel, cachedHintPayload?.subModel),
        transmission: pick(smsHint.transmission, cachedHintPayload?.transmission),
        transmissionType: pick(smsHint.transmissionType, cachedHintPayload?.transmissionType),
        engineDescription: pick(smsHint.engineDescription, cachedHintPayload?.engineDescription),
      };
    }
    let [specsResult, decodeResult] = await Promise.all([
      getVehicleSpecsLocal(upperVin, activeHint),
      decodeVinLocal(upperVin, activeHint),
    ]);

    // Backstop: ambiguous squish + cached CARFAX → mine the trim from
    // serviceHistory.model ("VERSA SV") and feed it back as a hint. SMS
    // hint always wins per-field; CARFAX only fills gaps. Skipped when a
    // resolved hint was already cached (it was merged above).
    if (!cachedHintPayload && decodeResult.ambiguous && shopId && decodeResult.decoded?.model) {
      const cf = await getCarfaxDecodeHint(shopId, upperVin, decodeResult.decoded.model);
      if (cf && (cf.trim || cf.engineDescription)) {
        // SMS hint wins per-field, but only when actually provided —
        // empty strings from `?trim=` shouldn't block CARFAX values.
        const merged: DecodeHint = {
          trim: pick(smsHint.trim, cf.trim),
          subModel: pick(smsHint.subModel, null),
          transmission: pick(smsHint.transmission, null),
          transmissionType: pick(smsHint.transmissionType, null),
          engineDescription: pick(smsHint.engineDescription, cf.engineDescription),
        };
        [specsResult, decodeResult] = await Promise.all([
          getVehicleSpecsLocal(upperVin, merged),
          decodeVinLocal(upperVin, merged),
        ]);
        // Persist the CARFAX-derived hint per VIN so the double-decode and
        // the CARFAX lookup never run again for this vehicle.
        try {
          const { pgUpsertVehicleSpecsCache } = await import("@/lib/db/repositories/wave1");
          await pgUpsertVehicleSpecsCache({
            cacheKey: hintRowKey,
            vin: upperVin,
            payload: { trim: cf.trim ?? null, engineDescription: cf.engineDescription ?? null },
            fetchedAt: now,
            expiresAt: new Date(now.getTime() + HINT_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000),
          });
        } catch (hintErr) {
          console.warn("[Specs] failed to store resolved hint:", hintErr);
        }
      }
    }

    const vehicleInfo = decodeResult.ok && decodeResult.decoded ? {
      year: decodeResult.decoded.year,
      make: decodeResult.decoded.make,
      model: decodeResult.decoded.model,
      trim: decodeResult.decoded.trim,
      style: decodeResult.decoded.style,
      engine: decodeResult.decoded.engine_name,
      engineSize: decodeResult.decoded.engine_size,
      engineCylinders: decodeResult.decoded.engine_cylinders,
      transmission: decodeResult.decoded.trans_name,
      transType: decodeResult.decoded.trans_type,
      driveType: decodeResult.decoded.drive_type,
      fuelType: deriveFuelTypeLabel({
        fuelType: decodeResult.decoded.fuel_type,
        engineName: decodeResult.decoded.engine_name,
        engineInduction: decodeResult.decoded.engine_induction,
        engineAspiration: decodeResult.decoded.engine_aspiration,
        trim: decodeResult.decoded.trim,
        model: decodeResult.decoded.model,
      }),
      bodyType: decodeResult.decoded.body_type,
      doors: decodeResult.decoded.doors,
      wheelbase: decodeResult.decoded.wheelbase,
      brakeSystem: decodeResult.decoded.brake_system,
      countryOfMfr: decodeResult.decoded.country_of_mfr,
      ambiguous: decodeResult.ambiguous || false,
      ambiguousFields: decodeResult.ambiguousFields || [],
    } : null;

    const payload = {
      ...specsResult,
      vehicleInfo,
    };

    // Cache only successful builds (ambiguous-but-resolved intersections are
    // fine — they're stable results). Never cache failures so a transient DB
    // hiccup can't poison the vehicle.
    if (specsResult.ok) {
      try {
        const { pgUpsertVehicleSpecsCache } = await import("@/lib/db/repositories/wave1");
        await pgUpsertVehicleSpecsCache({
          cacheKey,
          vin: upperVin,
          payload,
          fetchedAt: now,
          expiresAt: new Date(now.getTime() + SPECS_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000),
        });
      } catch (storeErr) {
        console.warn("[Specs] failed to store specs cache:", storeErr);
      }
    }

    return NextResponse.json(payload);
  } catch (error) {
    console.error("Specs API error:", error);
    return NextResponse.json({ 
      ok: false, 
      vin: upperVin, 
      specs: [], 
      vehicleInfo: null,
      grouped: emptyGrouped,
      error: String(error) 
    });
  }
}
