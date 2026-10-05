import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import {
  getDashboardUpdateMarker,
  getDashboardUpdateToken,
} from "@/lib/dashboard-updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = await getDb();
    const update = await db.collection("dashboard_updates").findOne({ _id: "lastUpdate" } as any);
    
    return NextResponse.json({ 
      lastUpdate: getDashboardUpdateMarker(update, session.shopId),
      dashboardUpdateToken: getDashboardUpdateToken(update, session.shopId),
    });
  } catch (error) {
    return NextResponse.json({ lastUpdate: 0 });
  }
}
