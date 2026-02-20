import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getVehicleSpecsLocal, decodeVinLocal } from "@/lib/integrations/dataone-local";

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
  
  try {
    const [specsResult, decodeResult] = await Promise.all([
      getVehicleSpecsLocal(upperVin),
      decodeVinLocal(upperVin),
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
