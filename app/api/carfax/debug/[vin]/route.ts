import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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

  const shopId = String(session.shopId);
  const vin = params.vin?.toUpperCase();

  if (!vin) {
    return NextResponse.json({ error: "VIN required" }, { status: 400 });
  }

  const rows = await sql`
    SELECT * FROM carfax_reports
    WHERE shop_id = ${shopId} AND vin = ${vin}
    LIMIT 1
  `;
  
  const carfaxReport = rows[0];

  if (!carfaxReport) {
    return NextResponse.json({ 
      error: "No CARFAX report found for this VIN",
      vin,
      shopId 
    }, { status: 404 });
  }

  return NextResponse.json({
    vin,
    fetchedAt: carfaxReport.fetched_at,
    reportDate: carfaxReport.report_date,
    numberOfOwners: carfaxReport.number_of_owners,
    accidents: carfaxReport.accidents,
    lastReportedMileage: carfaxReport.last_reported_mileage,
    serviceRecordsCount: carfaxReport.service_records?.length ?? 0,
    serviceRecords: carfaxReport.service_records,
    raw: carfaxReport.raw,
  });
}
