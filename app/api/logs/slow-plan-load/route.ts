import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const body = await req.json();
    const { vin, seconds, timestamp } = body;

    const db = await getDb();
    
    await db.collection("slow_plan_load_logs").insertOne({
      vin: vin || "unknown",
      seconds: seconds || 0,
      shopId: session?.shopId || null,
      userEmail: session?.email || null,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      createdAt: new Date(),
      userAgent: req.headers.get("user-agent") || null,
    });

    console.warn(`[SLOW PLAN LOAD] VIN: ${vin}, Duration: ${seconds}s, Shop: ${session?.shopId || 'unknown'}`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Error logging slow plan load:", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
