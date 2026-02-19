import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { decodeVinLocal } from "@/lib/integrations/dataone-local";

export async function POST(request: NextRequest) {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const body = await request.json();
    const plate = String(body.plate || "").replace(/\s+/g, "").toUpperCase();
    const state = String(body.state || "").toUpperCase().trim();

    if (!plate || plate.length < 2) {
      return NextResponse.json({ error: "License plate is required" }, { status: 400 });
    }
    if (!state || state.length !== 2) {
      return NextResponse.json({ error: "Two-letter state code is required" }, { status: 400 });
    }

    const apiKey = process.env.PLATE_TO_VIN_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "Plate lookup service not configured" }, { status: 503 });
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
      return NextResponse.json({ error: "Plate lookup failed" }, { status: 502 });
    }

    const plateData = await plateRes.json();

    if (!plateData.success) {
      return NextResponse.json({
        success: false,
        error: plateData.message || "No VIN found for this plate/state combination",
      });
    }

    const vinData = plateData.vin || {};
    const vinStr = vinData.vin || "";
    if (!vinStr) {
      return NextResponse.json({
        success: false,
        error: "No VIN returned for this plate/state combination",
      });
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

    return NextResponse.json(result);
  } catch (error) {
    console.error("Plate lookup error:", error);
    return NextResponse.json({ error: "Failed to look up plate" }, { status: 500 });
  }
}
