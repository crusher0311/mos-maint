import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { decodeVinLocal } from "@/lib/integrations/dataone-local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const UNSUPPORTED_PLATE_REGIONS: Record<string, string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body.shopId) {
      return NextResponse.json({ error: "shopId is required" }, { status: 400, headers: corsHeaders });
    }

    const guard = await guardExtensionShopRequest(request, {
      smsShopId: body.shopId,
      provider: body.provider || "protractor",
      corsHeaders,
    });
    if (!guard.ok) return guard.response;

    const plate = String(body.plate || "").replace(/\s+/g, "").toUpperCase();
    const state = String(body.state || "").toUpperCase().trim();

    if (!plate || plate.length < 2) {
      return NextResponse.json({ error: "License plate is required" }, { status: 400, headers: corsHeaders });
    }
    if (!state || state.length !== 2) {
      return NextResponse.json({ error: "Two-letter state code is required" }, { status: 400, headers: corsHeaders });
    }

    if (UNSUPPORTED_PLATE_REGIONS[state]) {
      const province = UNSUPPORTED_PLATE_REGIONS[state];
      return NextResponse.json({
        success: false,
        unsupportedRegion: true,
        region: state,
        error: `Plate lookup isn't available for ${province} yet — our plate-to-VIN provider only covers US states. Please enter the VIN manually.`,
      }, { headers: corsHeaders });
    }

    const apiKey = process.env.PLATE_TO_VIN_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Plate lookup service not configured" }, { status: 503, headers: corsHeaders });
    }

    const plateRes = await fetch("https://platetovin.com/api/convert", {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ plate, state }),
    });

    if (!plateRes.ok) {
      console.error("PlateToVin API error:", plateRes.status, await plateRes.text());
      return NextResponse.json({ error: "Plate lookup failed" }, { status: 502, headers: corsHeaders });
    }

    const plateData = await plateRes.json();

    if (!plateData.success) {
      return NextResponse.json({
        success: false,
        error: plateData.message || "No VIN found for this plate/state combination",
      }, { headers: corsHeaders });
    }

    const vinData = plateData.vin || {};
    const vinStr = vinData.vin || "";
    if (!vinStr) {
      return NextResponse.json({
        success: false,
        error: "No VIN returned for this plate/state combination",
      }, { headers: corsHeaders });
    }

    const vin = String(vinStr).toUpperCase();

    const localDecode = await decodeVinLocal(vin);

    const result: Record<string, any> = {
      success: true,
      vin,
      plateSource: {
        year: vinData.year || null,
        make: vinData.make || null,
        model: vinData.model || null,
        trim: vinData.trim || null,
        engine: vinData.engine || null,
        transmission: vinData.transmission || null,
        driveType: vinData.driveType || null,
        fuel: vinData.fuel || null,
        color: vinData.color?.name || null,
        style: vinData.style || null,
      },
    };

    if (localDecode.ok && localDecode.decoded) {
      const d = localDecode.decoded;
      result.decoded = true;
      result.year = d.year || vinData.year || null;
      result.make = d.make || vinData.make || null;
      result.model = d.model || vinData.model || null;
      result.submodel = d.style || vinData.trim || null;
      result.engine = d.engine_name || vinData.engine || null;
      result.transmission = d.trans_name || vinData.transmission || null;
      result.driveType = d.drive_type || vinData.driveType || null;
      result.fuelType = d.fuel_type || vinData.fuel || null;
      result.bodyType = d.body_type || vinData.style || null;
      result.color = vinData.color?.name || null;
    } else {
      result.decoded = false;
      result.year = vinData.year || null;
      result.make = vinData.make || null;
      result.model = vinData.model || null;
      result.submodel = vinData.trim || null;
      result.engine = vinData.engine || null;
      result.transmission = vinData.transmission || null;
      result.driveType = vinData.driveType || null;
      result.color = vinData.color?.name || null;
    }

    return NextResponse.json(result, { headers: corsHeaders });
  } catch (error) {
    console.error("[Extension Plate lookup] Error:", error);
    return NextResponse.json({ error: "Failed to look up plate" }, { status: 500, headers: corsHeaders });
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const POST = withExtensionErrorMarker(_POST as any);
