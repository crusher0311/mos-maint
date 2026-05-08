import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus } from "@/lib/extension-auth";
import { getVehicleSpecsLocal, decodeVinLocal, type DecodeHint } from "@/lib/integrations/dataone-local";
import { deriveFuelTypeLabel } from "@/lib/fuel-type-label";
import { getCarfaxDecodeHint } from "@/lib/integrations/carfax";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  const auth = await validateExtensionToken(req);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: corsHeaders });
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

  try {
    let activeHint: DecodeHint | undefined = hasSmsHint ? smsHint : undefined;
    let [specsResult, decodeResult] = await Promise.all([
      getVehicleSpecsLocal(upperVin, activeHint),
      decodeVinLocal(upperVin, activeHint),
    ]);

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
        [specsResult, decodeResult] = await Promise.all([
          getVehicleSpecsLocal(upperVin, merged),
          decodeVinLocal(upperVin, merged),
        ]);
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

    return NextResponse.json({
      ok: specsResult.ok,
      vin: vin.toUpperCase(),
      vehicleInfo,
      grouped: specsResult.grouped,
      specsCount: specsResult.specs.length,
    }, { headers: corsHeaders });
  } catch (error) {
    console.error("Extension specs API error:", error);
    return NextResponse.json({
      ok: false,
      vin: vin.toUpperCase(),
      error: String(error),
    }, { status: 500, headers: corsHeaders });
  }
}
