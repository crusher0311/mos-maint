import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getCallActivity } from "@/lib/db/repositories/comm-conversations";
import { ensureCommunicationsTables } from "@/lib/db/init";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureCommunicationsTables();

    const { searchParams } = req.nextUrl;
    const startDate = searchParams.get("startDate") || undefined;
    const endDate = searchParams.get("endDate") || undefined;

    const activity = await getCallActivity(session.shopId, startDate, endDate);

    return NextResponse.json({ activity });
  } catch (error: any) {
    console.error("Call activity error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to get call activity" },
      { status: 500 }
    );
  }
}
