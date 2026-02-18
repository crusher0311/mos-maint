import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    const update = await db.collection("dashboard_updates").findOne({ _id: "lastUpdate" } as any);
    
    return NextResponse.json({ 
      lastUpdate: update?.timestamp || 0 
    });
  } catch (error) {
    return NextResponse.json({ lastUpdate: 0 });
  }
}
