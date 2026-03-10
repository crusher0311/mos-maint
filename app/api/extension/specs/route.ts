import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus } from "@/lib/extension-auth";
import { getVehicleSpecsLocal, decodeVinLocal } from "@/lib/integrations/dataone-local";

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

  const vin = req.nextUrl.searchParams.get("vin");
  if (!vin) {
    return NextResponse.json({ error: "VIN parameter required" }, { status: 400, headers: corsHeaders });
  }

  try {
    const [specsResult, decodeResult] = await Promise.all([
      getVehicleSpecsLocal(vin.toUpperCase()),
      decodeVinLocal(vin.toUpperCase()),
    ]);

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
      fuelType: decodeResult.decoded.fuel_type,
      bodyType: decodeResult.decoded.body_type,
      doors: decodeResult.decoded.doors,
      wheelbase: decodeResult.decoded.wheelbase,
      brakeSystem: decodeResult.decoded.brake_system,
      countryOfMfr: decodeResult.decoded.country_of_mfr,
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
