import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { decodeVinLocal } from "@/lib/integrations/dataone-local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const shopIdParam = searchParams.get("shopId");
    const vin = searchParams.get("vin")?.toUpperCase().trim();

    if (!shopIdParam) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }
    if (!vin || vin.length !== 17) {
      return NextResponse.json({ error: "Valid 17-character VIN required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(req, {
      smsShopId: shopIdParam,
      provider: searchParams.get("provider") || "protractor",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    // Optional disambiguation hints from the caller's vehicle record.
    const hint = {
      trim: searchParams.get("trim"),
      subModel: searchParams.get("subModel"),
      transmission: searchParams.get("transmission"),
      transmissionType: searchParams.get("transmissionType"),
      engineDescription: searchParams.get("engine"),
    };
    const hasHint = Object.values(hint).some((v) => v && v.trim().length > 0);

    const result = await decodeVinLocal(vin, hasHint ? hint : undefined);

    if (!result.ok || !result.decoded) {
      return NextResponse.json({ vin, year: null, make: null, model: null, decoded: false }, { headers: corsHeaders });
    }

    const d = result.decoded;
    return NextResponse.json({
      vin,
      decoded: true,
      year: d.year || null,
      make: d.make || null,
      model: d.model || null,
      trim: d.trim || null,
      submodel: d.style || null,
      engine: d.engine_name || null,
      engineSize: d.engine_size || null,
      engineCylinders: d.engine_cylinders || null,
      transmission: d.trans_name || null,
      transmissionType: d.trans_type || null,
      driveType: d.drive_type || null,
      fuelType: d.fuel_type || null,
      bodyType: d.body_type || null,
      doors: d.doors || null,
      vehicleType: d.vehicle_type || null,
      countryOfMfr: d.country_of_mfr || null,
      ambiguous: result.ambiguous || false,
      ambiguousFields: result.ambiguousFields || [],
      candidateCount: result.candidateCount || 1,
    }, { headers: corsHeaders });
  } catch (error) {
    console.error("[Extension VIN decode] Error:", error);
    return NextResponse.json({ error: "Failed to decode VIN" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
