import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { vin: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const vin = params.vin?.toUpperCase();

  if (!vin) {
    return NextResponse.json({ error: "VIN required" }, { status: 400 });
  }

  const db = await getDb();
  
  const carfaxReport = await db.collection("carfax_reports").findOne({
    shopId,
    vin,
  });

  if (!carfaxReport) {
    return NextResponse.json({ 
      error: "No CARFAX report found for this VIN",
      vin,
      shopId 
    }, { status: 404 });
  }

  return NextResponse.json({
    vin,
    fetchedAt: carfaxReport.fetchedAt,
    reportDate: carfaxReport.reportDate,
    numberOfOwners: carfaxReport.numberOfOwners,
    accidents: carfaxReport.accidents,
    lastReportedMileage: carfaxReport.lastReportedMileage,
    serviceRecordsCount: carfaxReport.serviceRecords?.length ?? 0,
    serviceRecords: carfaxReport.serviceRecords,
    raw: carfaxReport.raw,
  });
}
