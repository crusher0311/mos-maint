import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db/postgres";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const smsShopId = searchParams.get("shopId");

    if (!smsShopId) {
      return NextResponse.json(
        { error: "shopId is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin });
    
    if (!shopResult) {
      return NextResponse.json(
        { error: `No accessible shop configured for SMS shop ID ${smsShopId}` },
        { status: 404, headers: corsHeaders }
      );
    }
    
    const mosShopId = shopResult.mosShopId;

    const cannedJobRows = await sql`
      SELECT id, title, name, description, code, chapter, maintenance_interval, labor_lines, part_lines, total_amount
      FROM canned_jobs
      WHERE shop_id = ${String(mosShopId)} AND enriched = true
      LIMIT 100
    `;

    const shopRows = await sql`
      SELECT maintenance_intervals FROM shops WHERE shop_id = ${String(mosShopId)} LIMIT 1
    `;

    const shopIntervals = (shopRows[0]?.maintenance_intervals as any[]) || [];

    const jobs = [
      ...cannedJobRows.map((job: any) => ({
        id: job.id,
        name: job.title || job.name,
        description: job.description,
        code: job.code,
        chapter: job.chapter,
        interval: job.maintenance_interval,
        source: "mos",
        laborItems: job.labor_lines || [],
        parts: job.part_lines || [],
        amount: job.total_amount || 0
      })),
      ...shopIntervals.map((interval: any) => ({
        id: `interval_${interval.service}`,
        name: interval.service,
        description: `Due every ${interval.miles?.toLocaleString()} miles or ${interval.months} months`,
        interval: interval.miles,
        source: "shop_interval",
        laborItems: [],
        parts: [],
        amount: 0
      }))
    ];

    return NextResponse.json({ 
      jobs,
      total: jobs.length
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Canned Jobs] Error:", error);
    return NextResponse.json(
      { error: "Failed to load canned jobs" },
      { status: 500, headers: corsHeaders }
    );
  }
}
