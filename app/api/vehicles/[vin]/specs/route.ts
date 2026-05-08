import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getVehicleSpecsLocal, decodeVinLocal } from "@/lib/integrations/dataone-local";
import { deriveFuelTypeLabel } from "@/lib/fuel-type-label";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ vin: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { vin } = await params;
  const upperVin = vin.toUpperCase();

  // Optional disambiguation hints — caller passes the SMS vehicle's stored
  // trim/subModel/transmission so an ambiguous squish can resolve to one row.
  const sp = req.nextUrl.searchParams;
  const hint = {
    trim: sp.get("trim"),
    subModel: sp.get("subModel"),
    transmission: sp.get("transmission"),
    transmissionType: sp.get("transmissionType"),
    engineDescription: sp.get("engine"),
  };
  const hasHint = Object.values(hint).some((v) => v && v.trim().length > 0);

  try {
    const [specsResult, decodeResult] = await Promise.all([
      getVehicleSpecsLocal(upperVin, hasHint ? hint : undefined),
      decodeVinLocal(upperVin, hasHint ? hint : undefined),
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
      ...specsResult,
      vehicleInfo,
    });
  } catch (error) {
    console.error("Specs API error:", error);
    return NextResponse.json({ 
      ok: false, 
      vin: upperVin, 
      specs: [], 
      vehicleInfo: null,
      grouped: {
        weightsAndCapacities: {},
        wheelsAndTires: {},
        brakes: {},
        dimensions: {},
        truckSpecs: {},
        seating: {},
        interior: {},
      },
      error: String(error) 
    });
  }
}
