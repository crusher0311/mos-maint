import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ count: 0, showBadge: false });
    }

    const shopId = String(session.shopId);
    const numericShopId = Number(session.shopId);
    
    const entitlements = await getFeatureEntitlements(numericShopId);
    const hasAutoBooking = entitlements.canUseFeature("auto_booking");
    
    if (!hasAutoBooking) {
      return NextResponse.json({ count: 0, showBadge: false, available: false });
    }
    
    const shopResult = await sql`
      SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1
    `;
    const settings = (shopResult[0]?.settings as Record<string, unknown>) || {};
    const autoBooking = (settings.autoBooking as Record<string, unknown>) || {};
    
    const confirmationMode = autoBooking.confirmationMode || "review";
    const isReviewMode = confirmationMode === "review";
    
    if (!isReviewMode) {
      return NextResponse.json({
        count: 0,
        showBadge: false,
        confirmationMode,
        available: true
      });
    }
    
    const pendingResult = await sql`
      SELECT COUNT(*) as count FROM auto_booking_queue
      WHERE shop_id = ${shopId} AND status = 'pending'
    `;
    const pendingCount = Number(pendingResult[0]?.count) || 0;
    
    return NextResponse.json({
      count: pendingCount,
      showBadge: pendingCount > 0,
      confirmationMode,
      available: true
    });
  } catch (err: unknown) {
    console.error("[Booking Pending Count] Error:", err);
    return NextResponse.json({ count: 0, showBadge: false });
  }
}
