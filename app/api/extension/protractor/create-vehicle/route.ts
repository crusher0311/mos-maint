import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { checkExtensionWritePermission } from "@/lib/extension-write-guard";
import { createServiceItem } from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      shopId,
      ownerId,
      vin,
      year,
      make,
      model,
      submodel,
      color,
      engine,
      transmission,
      odometer,
      licensePlate,
    } = body;

    if (!shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!ownerId) {
      return NextResponse.json({ error: "Owner contact ID is required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopId,
      provider: body.provider || "protractor",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const writeDenied = checkExtensionWritePermission(guard.user);
    if (writeDenied) {
      return NextResponse.json({ error: writeDenied }, { status: 403, headers: corsHeaders });
    }

    const result = await createServiceItem(guard.mosShopId, {
      ownerId,
      vin: vin || undefined,
      year: year ? Number(year) : undefined,
      make: make || undefined,
      model: model || undefined,
      submodel: submodel || undefined,
      color: color || undefined,
      engine: engine || undefined,
      transmission: transmission || undefined,
      odometer: odometer ? Number(odometer) : undefined,
      licensePlate: licensePlate || undefined,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500, headers: corsHeaders });
    }

    return NextResponse.json(
      { success: true, vehicleId: result.vehicleId, vehicle: result.vehicle },
      { headers: corsHeaders },
    );
  } catch (err: any) {
    console.error("[Extension Protractor Create Vehicle] Error:", err);
    return NextResponse.json({ error: err.message || "Internal error" }, { status: 500, headers: corsHeaders });
  }
}
