import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { resolveCarfaxConfig, fetchCarfaxWithCache } from "@/lib/integrations/carfax";

function parseCarfaxDate(val: string | null): Date | null {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const vin = req.nextUrl.searchParams.get("vin");
  if (!vin) {
    return NextResponse.json({ error: "VIN required" }, { status: 400 });
  }

  const shopId = Number(session.shopId);
  if (!shopId) {
    return NextResponse.json({ error: "No shop associated" }, { status: 400 });
  }

  try {
    const vehicleRows = await sql`
      SELECT last_mileage, odometer FROM vehicles WHERE vin = ${vin.toUpperCase()}
    `;
    const vehicle = vehicleRows[0] as any;
    const currentMiles = vehicle?.last_mileage ?? vehicle?.odometer ?? null;

    const carfaxCfg = await resolveCarfaxConfig(shopId);
    if (!carfaxCfg.configured) {
      return NextResponse.json({
        vin: vin.toUpperCase(),
        milesPerDay: null,
        hasEnoughData: false,
        source: "no_carfax",
      });
    }

    const carfax = await fetchCarfaxWithCache(shopId, vin, 7 * 24 * 60 * 60 * 1000);

    if (!(carfax as any).ok || !Array.isArray((carfax as any).serviceRecords)) {
      return NextResponse.json({
        vin: vin.toUpperCase(),
        milesPerDay: null,
        hasEnoughData: false,
        source: "carfax_error",
      });
    }

    const recs = ((carfax as any).serviceRecords as any[])
      .map((r: any) => ({
        date: parseCarfaxDate(r?.date ?? null),
        miles: typeof r?.odometer === "number" ? r.odometer : null,
      }))
      .filter((r): r is { date: Date; miles: number } => r.date !== null && r.miles !== null);

    recs.sort((a, b) => b.date.getTime() - a.date.getTime());

    let mpdFromToday: number | null = null;
    let mpdFromTwo: number | null = null;
    let mpdBlended: number | null = null;

    const now = new Date();
    const todayIsValid = typeof currentMiles === "number" && currentMiles > 0 && (!recs[0] || currentMiles >= recs[0].miles);

    if (todayIsValid && recs[0]) {
      const days = Math.max(1, daysBetween(now, recs[0].date));
      const delta = currentMiles - recs[0].miles;
      const val = delta / days;
      mpdFromToday = Math.abs(val) < 0.01 ? null : val;
    }

    if (recs[0] && recs[1]) {
      const days = Math.max(1, daysBetween(recs[0].date, recs[1].date));
      const delta = recs[0].miles - recs[1].miles;
      mpdFromTwo = delta / days;
    }

    if (mpdFromToday != null && mpdFromTwo != null) {
      mpdBlended = (mpdFromToday + mpdFromTwo) / 2;
    } else {
      mpdBlended = mpdFromTwo ?? mpdFromToday ?? null;
    }

    return NextResponse.json({
      vin: vin.toUpperCase(),
      milesPerDay: mpdBlended != null && mpdBlended > 0 ? Math.round(mpdBlended * 10) / 10 : null,
      hasEnoughData: mpdBlended != null && mpdBlended > 0,
      source: "carfax",
      currentMiles,
      records: recs.length,
    });
  } catch (error) {
    console.error("Driving stats error:", error);
    return NextResponse.json(
      { error: "Failed to calculate driving stats" },
      { status: 500 }
    );
  }
}
