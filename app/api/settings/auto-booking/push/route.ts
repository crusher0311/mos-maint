import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  pushConfirmedBooking,
  pushAllConfirmedBookings,
  retryFailedBooking,
} from "@/lib/auto-booking/appointment-pusher";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { shopId } = session;
  if (!shopId) {
    return NextResponse.json({ error: "No shop selected" }, { status: 400 });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { enabledFeatures: 1, billingStatus: 1, plan: 1 } }
  );

  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }

  const rawFeatures = shop.enabledFeatures;
  const hasOilSticker = Array.isArray(rawFeatures)
    ? rawFeatures.includes("oil_sticker")
    : rawFeatures &&
      typeof rawFeatures === "object" &&
      (rawFeatures as any).oil_sticker === true;
  const isPaid =
    shop.billingStatus === "active" ||
    shop.plan === "professional" ||
    shop.plan === "enterprise";

  if (!isPaid || !hasOilSticker) {
    return NextResponse.json(
      { error: "Auto Booking requires a paid plan with Oil Sticker enabled" },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const { action, bookingId } = body;

    if (action === "push_single" && bookingId) {
      const result = await pushConfirmedBooking(shopId, bookingId);
      return NextResponse.json(result);
    }

    if (action === "push_all") {
      const results = await pushAllConfirmedBookings(shopId);
      return NextResponse.json(results);
    }

    if (action === "retry" && bookingId) {
      const result = await retryFailedBooking(shopId, bookingId);
      return NextResponse.json(result);
    }

    return NextResponse.json(
      { error: "Invalid action. Use: push_single, push_all, or retry" },
      { status: 400 }
    );
  } catch (error) {
    console.error("[AutoBooking Push] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
