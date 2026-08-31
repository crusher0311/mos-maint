import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getAuthErrorStatus , buildAuthErrorBody } from "@/lib/extension-auth";
import { getVehicleSpecsLocal, decodeVinLocal, type DecodeHint } from "@/lib/integrations/dataone-local";
import { deriveFuelTypeLabel } from "@/lib/fuel-type-label";
import { getCarfaxDecodeHint } from "@/lib/integrations/carfax";
import {
  resolveSpecsUnitDisplayFromShop,
  callDataOneWithRetry,
  DataOneCallError,
  type DataOneCallers,
} from "./unit-resolver";
import { readSpecsCache, writeSpecsCache } from "./specs-cache";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";

// Re-export so other code paths can import from the route module if needed.
export { resolveSpecsUnitDisplayFromShop, callDataOneWithRetry } from "./unit-resolver";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

type SpecsResult = Awaited<ReturnType<typeof getVehicleSpecsLocal>>;
type DecodeResult = Awaited<ReturnType<typeof decodeVinLocal>>;

const REAL_CALLERS: DataOneCallers<SpecsResult, DecodeResult, DecodeHint> = {
  getSpecs: getVehicleSpecsLocal,
  decode: decodeVinLocal,
};

async function loadShopDoc(shopId: number): Promise<any | null> {
  if (shopId <= 0) return null;
  try {
    const db = await getDb();
    return await db
      .collection("shops")
      .findOne(
        { shopId: { $in: [shopId, String(shopId)] } as any },
        { projection: { preferences: 1, settings: 1 } },
      );
  } catch (err) {
    console.warn(`[Extension specs] shop preference lookup failed for shop ${shopId}:`, err);
    return null;
  }
}

async function _GET(req: NextRequest) {
  const auth = await validateExtensionToken(req);
  if (!auth.authorized) {
    return NextResponse.json(buildAuthErrorBody(auth), { status: getAuthErrorStatus(auth), headers: corsHeaders });
  }

  const sp = req.nextUrl.searchParams;
  const vin = sp.get("vin");
  if (!vin) {
    return NextResponse.json({ error: "VIN parameter required" }, { status: 400, headers: corsHeaders });
  }

  // Optional disambiguation hints from the SMS vehicle record (extension passes
  // these from Tekmetric / Protractor / Shop-Ware when available).
  const smsHint: DecodeHint = {
    trim: sp.get("trim"),
    subModel: sp.get("subModel"),
    transmission: sp.get("transmission"),
    transmissionType: sp.get("transmissionType"),
    engineDescription: sp.get("engine"),
  };
  const hasSmsHint = Object.values(smsHint).some((v) => v && String(v).trim().length > 0);
  const upperVin = vin.toUpperCase();
  const shopId = Number(auth.user?.shopId ?? 0);
  const featureFailure = await checkShopFeatureGate(shopId, ["maintenance"], {
    featureLabel: "Maintenance",
    corsHeaders,
  });
  if (featureFailure) return featureFailure;

  const requestStarted = Date.now();
  try {
    const shopDoc = await loadShopDoc(shopId);
    const { distanceUnit, unitDisplay } = resolveSpecsUnitDisplayFromShop(shopDoc);

    // Serve a previously-decoded VIN straight from cache. A VIN's specs are
    // static, so this skips the live DataOne hit entirely — instant for the
    // user and zero extra load on DataOne (which under connection pressure
    // refuses queries with PG 53300 and makes specs silently disappear).
    // Shop-specific unit display is still applied per-request above.
    const cached = await readSpecsCache(upperVin);
    if (cached) {
      return NextResponse.json({
        ok: true,
        vin: upperVin,
        vehicleInfo: cached.vehicleInfo,
        grouped: cached.grouped,
        specsCount: cached.specsCount,
        distanceUnit,
        unitDisplay,
        cached: true,
      }, { headers: corsHeaders });
    }

    let activeHint: DecodeHint | undefined = hasSmsHint ? smsHint : undefined;
    let { specsResult, decodeResult } = await callDataOneWithRetry(upperVin, activeHint, {
      vin: upperVin,
      hasHint: hasSmsHint,
    }, { callers: REAL_CALLERS });

    // Backstop: if still ambiguous, mine the cached CARFAX report (if any).
    // CARFAX's serviceHistory.model bakes in the trim ("VERSA SV") and gives
    // us engine + driveline — enough to resolve most ambiguous squishes.
    // SMS-derived hint always wins per-field; CARFAX only fills gaps.
    if (decodeResult.ambiguous && shopId && decodeResult.decoded?.model) {
      const cf = await getCarfaxDecodeHint(shopId, upperVin, decodeResult.decoded.model);
      if (cf && (cf.trim || cf.engineDescription)) {
        // SMS hint wins per-field, but only when actually provided —
        // empty strings from `?trim=` shouldn't block CARFAX values.
        const pick = (a: string | null | undefined, b: string | null | undefined) =>
          (a && a.trim()) ? a : (b && b.trim() ? b : null);
        const merged: DecodeHint = {
          trim: pick(smsHint.trim, cf.trim),
          subModel: pick(smsHint.subModel, null),
          transmission: pick(smsHint.transmission, null),
          transmissionType: pick(smsHint.transmissionType, null),
          engineDescription: pick(smsHint.engineDescription, cf.engineDescription),
        };
        ({ specsResult, decodeResult } = await callDataOneWithRetry(upperVin, merged, {
          vin: upperVin,
          hasHint: true,
        }, { callers: REAL_CALLERS }));
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

    // Cache only confident results: a successful, UNAMBIGUOUS decode with
    // specs. We never cache a failure (e.g. DataOne refused the connection)
    // or an ambiguous decode (those need live per-RO hints to resolve).
    if (decodeResult.ok && !decodeResult.ambiguous && specsResult.ok) {
      await writeSpecsCache(upperVin, {
        vehicleInfo,
        grouped: specsResult.grouped,
        specsCount: specsResult.specs.length,
      });
    }

    return NextResponse.json({
      ok: specsResult.ok,
      vin: vin.toUpperCase(),
      vehicleInfo,
      grouped: specsResult.grouped,
      specsCount: specsResult.specs.length,
      // Task #491: tell the extension which units to render with so the
      // Specs tab stops hardcoding imperial (`"`, `cu ft`) for metric shops.
      distanceUnit,
      unitDisplay,
    }, { headers: corsHeaders });
  } catch (error) {
    const elapsed = Date.now() - requestStarted;
    const which = error instanceof DataOneCallError ? error.which : "unknown";
    console.error(
      `[Extension specs] API error (vin=${upperVin}, hasHint=${hasSmsHint}, shopId=${shopId}, elapsedMs=${elapsed}, which=${which}):`,
      error,
    );
    return NextResponse.json({
      ok: false,
      vin: vin.toUpperCase(),
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
