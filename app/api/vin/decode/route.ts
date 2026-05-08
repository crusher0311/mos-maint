import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { decodeVinLocal } from "@/lib/integrations/dataone-local";
import { findActiveSessionByToken } from "@/lib/data/repositories/sessions";

export async function GET(request: NextRequest) {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const sess = await findActiveSessionByToken(sid);
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const vin = searchParams.get("vin")?.toUpperCase().trim();

    if (!vin || vin.length !== 17) {
      return NextResponse.json({ error: "Valid 17-character VIN required" }, { status: 400 });
    }

    // Optional disambiguation hints from the caller's SMS vehicle record.
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
      return NextResponse.json({ vin, year: null, make: null, model: null, decoded: false });
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
    });
  } catch (error) {
    console.error("VIN decode error:", error);
    return NextResponse.json({ error: "Failed to decode VIN" }, { status: 500 });
  }
}
