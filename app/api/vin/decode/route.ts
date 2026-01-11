import { NextRequest, NextResponse } from "next/server";
import { decodeVin } from "@/lib/integrations/dataone-api";
import { requireSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    await requireSession();
    
    const { searchParams } = new URL(request.url);
    const vin = searchParams.get("vin");
    
    if (!vin || vin.length < 11) {
      return NextResponse.json({ error: "Valid VIN required (11-17 characters)" }, { status: 400 });
    }
    
    const result = await decodeVin(vin.toUpperCase());
    
    if (!result.ok || !result.decoded) {
      return NextResponse.json({ 
        vin: vin.toUpperCase(),
        year: null,
        make: null,
        model: null,
        error: result.error || "Unable to decode VIN"
      });
    }
    
    return NextResponse.json({
      vin: vin.toUpperCase(),
      year: result.decoded.year,
      make: result.decoded.make,
      model: result.decoded.model,
      trim: result.decoded.trim,
      engine: result.decoded.engine_name,
      transmission: result.decoded.trans_name,
      driveType: result.decoded.drive_type,
      fuelType: result.decoded.fuel_type,
      bodyType: result.decoded.body_type,
    });
  } catch (error: any) {
    console.error("VIN decode error:", error);
    return NextResponse.json({ error: error.message || "Failed to decode VIN" }, { status: 500 });
  }
}
