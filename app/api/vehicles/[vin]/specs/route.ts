import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getVehicleSpecsLocal } from "@/lib/integrations/dataone-local";

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
  
  try {
    const result = await getVehicleSpecsLocal(vin.toUpperCase());
    return NextResponse.json(result);
  } catch (error) {
    console.error("Specs API error:", error);
    return NextResponse.json({ 
      ok: false, 
      vin: vin.toUpperCase(), 
      specs: [], 
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
