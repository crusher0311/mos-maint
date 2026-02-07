import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { decodeVinLocal } from "@/lib/integrations/dataone-local";

export async function GET(request: NextRequest) {
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

    const { searchParams } = new URL(request.url);
    const vin = searchParams.get("vin")?.toUpperCase().trim();

    if (!vin || vin.length !== 17) {
      return NextResponse.json({ error: "Valid 17-character VIN required" }, { status: 400 });
    }

    const result = await decodeVinLocal(vin);

    if (!result.ok || !result.decoded) {
      return NextResponse.json({ vin, year: null, make: null, model: null });
    }

    const d = result.decoded;
    return NextResponse.json({
      vin,
      year: d.year || null,
      make: d.make || null,
      model: d.model || null,
      engine: d.engine_name || null,
    });
  } catch (error) {
    console.error("VIN decode error:", error);
    return NextResponse.json({ error: "Failed to decode VIN" }, { status: 500 });
  }
}
