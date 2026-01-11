import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { sendEmail, makePendingBookingsReminderEmail } from "@/lib/email";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    if (!shopId) {
      return NextResponse.json({ error: "No shop selected" }, { status: 400 });
    }

    const db = await getDb();

    const pendingCount = await db.collection("auto_booking_queue").countDocuments({
      shopId,
      status: "pending",
    });

    if (pendingCount === 0) {
      return NextResponse.json({ 
        ok: true, 
        sent: 0, 
        message: "No pending bookings to notify about" 
      });
    }

    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { name: 1 } }
    );
    const shopName = shop?.name || `Shop #${shopId}`;

    const users = await db.collection("users").find({
      shopId,
      role: { $in: ["owner", "admin", "manager"] },
      email: { $exists: true, $ne: "" },
    }).toArray();

    if (users.length === 0) {
      return NextResponse.json({ 
        ok: true, 
        sent: 0, 
        message: "No users to notify (no owner/admin/manager with email found)" 
      });
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://mos.tools";
    const queueUrl = `${baseUrl}/dashboard/settings/auto-booking/queue`;

    const emailContent = makePendingBookingsReminderEmail(shopName, pendingCount, queueUrl);
    
    let sent = 0;
    const errors: string[] = [];

    for (const user of users) {
      try {
        await sendEmail({
          to: user.email,
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text,
        });
        sent++;
      } catch (err: any) {
        console.error(`[AutoBooking Notify] Failed to send to ${user.email}:`, err);
        errors.push(`${user.email}: ${err.message}`);
      }
    }

    await db.collection("auto_booking_notifications").insertOne({
      shopId,
      type: "pending_reminder",
      pendingCount,
      recipientCount: users.length,
      sentCount: sent,
      errors: errors.length > 0 ? errors : null,
      sentAt: new Date(),
      sentBy: session.email,
    });

    return NextResponse.json({
      ok: true,
      sent,
      total: users.length,
      pendingCount,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    console.error("[AutoBooking Notify] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    if (!shopId) {
      return NextResponse.json({ error: "No shop selected" }, { status: 400 });
    }

    const db = await getDb();

    const pendingCount = await db.collection("auto_booking_queue").countDocuments({
      shopId,
      status: "pending",
    });

    const lastNotification = await db.collection("auto_booking_notifications").findOne(
      { shopId, type: "pending_reminder" },
      { sort: { sentAt: -1 } }
    );

    const eligibleUsers = await db.collection("users").countDocuments({
      shopId,
      role: { $in: ["owner", "admin", "manager"] },
      email: { $exists: true, $ne: "" },
    });

    return NextResponse.json({
      pendingCount,
      eligibleRecipients: eligibleUsers,
      lastNotification: lastNotification ? {
        sentAt: lastNotification.sentAt,
        sentCount: lastNotification.sentCount,
        pendingCount: lastNotification.pendingCount,
      } : null,
    });
  } catch (err: any) {
    console.error("[AutoBooking Notify] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
