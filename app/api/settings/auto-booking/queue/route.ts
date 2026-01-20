import { NextResponse, NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { 
  getQueuedBookings, 
  confirmBooking, 
  cancelBooking 
} from "@/lib/auto-booking/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const status = req.nextUrl.searchParams.get("status");
    
    const statusFilter = status 
      ? status.split(",") 
      : ["pending", "confirmed", "sent"];
    
    const bookings = await getQueuedBookings(shopId, statusFilter);

    return NextResponse.json({ bookings });
  } catch (err: any) {
    console.error("[Auto Booking Queue] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { action, bookingId } = body;

    if (!bookingId) {
      return NextResponse.json({ error: "Booking ID required" }, { status: 400 });
    }

    if (action === "confirm") {
      const success = await confirmBooking(bookingId);
      if (success) {
        return NextResponse.json({ ok: true, message: "Booking confirmed" });
      } else {
        return NextResponse.json({ error: "Could not confirm booking" }, { status: 400 });
      }
    }

    if (action === "cancel") {
      const success = await cancelBooking(bookingId);
      if (success) {
        return NextResponse.json({ ok: true, message: "Booking cancelled" });
      } else {
        return NextResponse.json({ error: "Could not cancel booking" }, { status: 400 });
      }
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    console.error("[Auto Booking Queue] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
