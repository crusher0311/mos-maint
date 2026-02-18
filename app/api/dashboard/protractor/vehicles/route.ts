import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { fetchVehiclesByOwner } from "@/lib/integrations/protractor";

export async function GET(req: NextRequest) {
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

    const user = await db.collection("users").findOne({ _id: sess.userId });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const ownerId = req.nextUrl.searchParams.get("ownerId");
    if (!ownerId) {
      return NextResponse.json({ error: "Owner ID is required" }, { status: 400 });
    }

    const shopId = Number(user.shopId);
    const result = await fetchVehiclesByOwner(shopId, ownerId);

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    const vehicles = (result.vehicles || []).map(v => ({
      id: v.ID,
      vin: v.VIN || "",
      year: v.Year || null,
      make: v.Make || "",
      model: v.Model || "",
      submodel: v.Submodel || "",
      color: v.Color || "",
      plate: v.LicensePlate || v.LookUp || v.Lookup || "",
      odometer: v.Usage || v.Odometer || null,
    }));

    return NextResponse.json({ vehicles });
  } catch (err: any) {
    console.error("[Vehicle By Owner] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
