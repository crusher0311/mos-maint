import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getVehicleRecallsLocal } from "@/lib/integrations/dataone-local";

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
    const result = await getVehicleRecallsLocal(vin.toUpperCase());
    return NextResponse.json(result);
  } catch (error) {
    console.error("Recalls API error:", error);
    return NextResponse.json({ 
      ok: false, 
      vin: vin.toUpperCase(), 
      recalls: [], 
      count: 0,
      safetyCriticalCount: 0,
      error: String(error) 
    });
  }
}
