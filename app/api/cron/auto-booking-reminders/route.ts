import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail, makePendingBookingsReminderEmail } from "@/lib/email";
import { getBlockedHolidayDates, type CustomRecurringHoliday } from "@/lib/auto-booking/holidays";
import { markExpiredBookings } from "@/lib/auto-booking/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface AutoBookingSettings {
  enabled: boolean;
  reminderTime?: string;
  reminderDays?: number[];
  skipReminderHolidays?: boolean;
  blockHolidays?: boolean;
  enabledHolidays?: Record<string, boolean>;
  customHolidays?: Array<{ date: string; name: string }>;
  customRecurringHolidays?: CustomRecurringHoliday[];
  timezone?: string;
}

function getShopLocalTime(timezone: string): { hour: number; minute: number; dayOfWeek: number; dateStr: string } {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  });
  
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);
  const weekdayName = parts.find(p => p.type === "weekday")?.value || "Mon";
  const year = parts.find(p => p.type === "year")?.value || "2025";
  const month = parts.find(p => p.type === "month")?.value || "01";
  const day = parts.find(p => p.type === "day")?.value || "01";
  
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[weekdayName] ?? 1;
  const dateStr = `${year}-${month}-${day}`;
  
  return { hour, minute, dayOfWeek, dateStr };
}

function isWithinTimeWindow(currentHour: number, currentMinute: number, targetTime: string, windowMinutes: number = 30): boolean {
  const [targetHour, targetMinute] = targetTime.split(":").map(Number);
  const currentTotalMinutes = currentHour * 60 + currentMinute;
  const targetTotalMinutes = targetHour * 60 + targetMinute;
  
  return currentTotalMinutes >= targetTotalMinutes && currentTotalMinutes < targetTotalMinutes + windowMinutes;
}

function isTodayHoliday(dateStr: string, settings: AutoBookingSettings): boolean {
  if (settings.customHolidays?.some(h => h.date === dateStr)) {
    return true;
  }
  
  if (settings.blockHolidays !== false) {
    const blockedDates = getBlockedHolidayDates(
      settings.enabledHolidays || {},
      settings.customRecurringHolidays || []
    );
    
    if (blockedDates.has(dateStr)) {
      return true;
    }
  }
  
  return false;
}

async function sendRemindersForShop(shopId: number, shopName: string, localDate: string): Promise<{ sent: number; errors: string[] }> {
  const db = await getDb();
  
  const pendingCount = await db.collection("auto_booking_queue").countDocuments({
    shopId,
    status: "pending",
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: { $gt: new Date() } }
    ]
  });
  
  if (pendingCount === 0) {
    return { sent: 0, errors: [] };
  }
  
  const users = await db.collection("users").find({
    shopId,
    role: { $in: ["owner", "admin", "manager"] },
    email: { $exists: true, $ne: "" },
  }).toArray();
  
  if (users.length === 0) {
    return { sent: 0, errors: [] };
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
      console.error(`[Cron Reminder] Failed to send to ${user.email}:`, err);
      errors.push(`${user.email}: ${err.message}`);
    }
  }
  
  await db.collection("auto_booking_notifications").insertOne({
    shopId,
    type: "scheduled_reminder",
    localDate,
    pendingCount,
    recipientCount: users.length,
    sentCount: sent,
    errors: errors.length > 0 ? errors : null,
    sentAt: new Date(),
    sentBy: "cron",
  });
  
  return { sent, errors };
}

export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;
    
    if (!cronSecret) {
      console.error("[Cron Reminder] CRON_SECRET not configured");
      return NextResponse.json({ error: "Cron endpoint not configured" }, { status: 503 });
    }
    
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    
    const db = await getDb();
    
    const expiredCount = await markExpiredBookings();
    console.log(`[Cron Reminder] Marked ${expiredCount} bookings as expired`);
    
    const shopsWithAutoBooking = await db.collection("shops").find({
      "autoBooking.enabled": true,
    }, {
      projection: {
        shopId: 1,
        name: 1,
        autoBooking: 1,
      }
    }).toArray();
    
    const results: Array<{
      shopId: number;
      shopName: string;
      status: string;
      sent?: number;
      errors?: string[];
    }> = [];
    
    for (const shop of shopsWithAutoBooking) {
      const shopId = shop.shopId;
      const shopName = shop.name || `Shop #${shopId}`;
      const settings: AutoBookingSettings = shop.autoBooking || {};
      
      const timezone = settings.timezone || "America/New_York";
      const reminderTime = settings.reminderTime || "08:00";
      const reminderDays = settings.reminderDays ?? [1, 2, 3, 4, 5];
      const skipReminderHolidays = settings.skipReminderHolidays ?? true;
      
      const { hour, minute, dayOfWeek, dateStr } = getShopLocalTime(timezone);
      
      if (!reminderDays.includes(dayOfWeek)) {
        results.push({ shopId, shopName, status: "skipped_wrong_day" });
        continue;
      }
      
      if (!isWithinTimeWindow(hour, minute, reminderTime, 30)) {
        results.push({ shopId, shopName, status: "skipped_wrong_time" });
        continue;
      }
      
      if (skipReminderHolidays && isTodayHoliday(dateStr, settings)) {
        results.push({ shopId, shopName, status: "skipped_holiday" });
        continue;
      }
      
      const alreadySent = await db.collection("auto_booking_notifications").findOne({
        shopId,
        type: "scheduled_reminder",
        localDate: dateStr,
      });
      
      if (alreadySent) {
        results.push({ shopId, shopName, status: "skipped_already_sent_today" });
        continue;
      }
      
      const { sent, errors } = await sendRemindersForShop(shopId, shopName, dateStr);
      
      results.push({
        shopId,
        shopName,
        status: sent > 0 ? "sent" : "no_pending_or_recipients",
        sent,
        errors: errors.length > 0 ? errors : undefined,
      });
    }
    
    const totalSent = results.filter(r => r.status === "sent").reduce((sum, r) => sum + (r.sent || 0), 0);
    
    return NextResponse.json({
      ok: true,
      processedShops: shopsWithAutoBooking.length,
      expiredMarked: expiredCount,
      totalEmailsSent: totalSent,
      results,
    });
  } catch (err: any) {
    console.error("[Cron Reminder] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
