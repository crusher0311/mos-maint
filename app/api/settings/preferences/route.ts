import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: Number(sess.shopId) });

  return NextResponse.json({
    distanceUnit: shop?.preferences?.distanceUnit || "miles",
    timezone: shop?.preferences?.timezone || "America/New_York",
  });
}

export async function PUT(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { distanceUnit, timezone } = await req.json();

  if (distanceUnit && !["miles", "kilometers"].includes(distanceUnit)) {
    return NextResponse.json({ error: "Invalid distance unit" }, { status: 400 });
  }

  const db = await getDb();
  const updates: Record<string, any> = {};

  if (distanceUnit) updates["preferences.distanceUnit"] = distanceUnit;
  if (timezone) updates["preferences.timezone"] = timezone;

  await db.collection("shops").updateOne(
    { shopId: Number(sess.shopId) },
    { $set: updates }
  );

  return NextResponse.json({ success: true });
}
