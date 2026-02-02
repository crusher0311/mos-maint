import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ count: 0, showBadge: false });
    }

    const shopId = Number(session.shopId);
    const db = await getDb();
    
    const entitlements = await getFeatureEntitlements(shopId);
    const hasAutoBooking = entitlements.canUseFeature("auto_booking");
    
    if (!hasAutoBooking) {
      return NextResponse.json({ count: 0, showBadge: false, available: false });
    }
    
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { autoBooking: 1 } }
    );
    
    const confirmationMode = shop?.autoBooking?.confirmationMode || "review";
    const isReviewMode = confirmationMode === "review";
    
    // Only query pending count when in review mode to avoid unnecessary DB work
    if (!isReviewMode) {
      return NextResponse.json({
        count: 0,
        showBadge: false,
        confirmationMode,
        available: true
      });
    }
    
    const pendingCount = await db.collection("auto_booking_queue").countDocuments({
      shopId,
      status: "pending"
    });
    
    return NextResponse.json({
      count: pendingCount,
      showBadge: pendingCount > 0,
      confirmationMode,
      available: true
    });
  } catch (err: any) {
    console.error("[Booking Pending Count] Error:", err);
    return NextResponse.json({ count: 0, showBadge: false });
  }
}
