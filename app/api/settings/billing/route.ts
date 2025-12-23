import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();

  const shop = await db.collection("shops").findOne({ shopId: sess.shopId });

  const vehicleCount = await db.collection("vehicles").countDocuments({ shopId: String(sess.shopId) });

  const billing = shop?.billing || {};

  return NextResponse.json({
    plan: billing.plan || "Free Trial",
    status: billing.status || "trial",
    vehicleCount,
    vehicleLimit: billing.vehicleLimit || 50,
    nextBillingDate: billing.nextBillingDate,
  });
}
