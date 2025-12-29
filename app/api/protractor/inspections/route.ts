import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { fetchAllActiveInspections, fetchActiveInspections } from "@/lib/integrations/protractor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    if (!shopId) {
      return NextResponse.json({ error: "No shop associated" }, { status: 400 });
    }

    const workOrderId = req.nextUrl.searchParams.get("workOrderId");

    if (workOrderId) {
      const result = await fetchActiveInspections(shopId, workOrderId);
      return NextResponse.json(result);
    } else {
      const result = await fetchAllActiveInspections(shopId);
      return NextResponse.json(result);
    }
  } catch (err: any) {
    console.error("[Protractor Inspections] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
