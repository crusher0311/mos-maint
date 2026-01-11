import { getDb } from "@/lib/mongo";
import { getBlockedHolidayDates } from "./holidays";

export interface AutoBookingSettings {
  enabled: boolean;
  leadTimeDays: number;
  blockSaturday: boolean;
  blockSunday: boolean;
  blockHolidays: boolean;
  enabledHolidays: Record<string, boolean>;
  customHolidays: Array<{ date: string; name: string }>;
  businessHours: {
    start: string;
    end: string;
  };
  maxBookingsPerDay: number;
  confirmationMode: "auto" | "review";
  preferredTimeSlot: "morning" | "afternoon" | "any";
  timezone: string;
}

export interface BookingSlot {
  date: string;
  time: string;
  datetime: Date;
  available: boolean;
  reason?: string;
}

export interface ScheduleResult {
  success: boolean;
  slot?: BookingSlot;
  error?: string;
  attempts: BookingSlot[];
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function getDayOfWeek(date: Date): number {
  return date.getDay();
}

function isWeekend(date: Date, settings: AutoBookingSettings): boolean {
  const day = getDayOfWeek(date);
  if (settings.blockSaturday && day === 6) return true;
  if (settings.blockSunday && day === 0) return true;
  return false;
}

function isHoliday(dateStr: string, settings: AutoBookingSettings): boolean {
  if (!settings.blockHolidays) return false;
  
  const blockedDates = getBlockedHolidayDates(settings.enabledHolidays);
  if (blockedDates.has(dateStr)) {
    return true;
  }
  
  if (settings.customHolidays?.some(h => h.date === dateStr)) {
    return true;
  }
  
  return false;
}

function getPreferredTime(settings: AutoBookingSettings): string {
  const [startHour] = settings.businessHours.start.split(":").map(Number);
  const [endHour] = settings.businessHours.end.split(":").map(Number);
  
  switch (settings.preferredTimeSlot) {
    case "morning":
      return settings.businessHours.start;
    case "afternoon":
      const afternoonHour = Math.max(12, Math.floor((startHour + endHour) / 2));
      return `${afternoonHour.toString().padStart(2, "0")}:00`;
    case "any":
    default:
      return settings.businessHours.start;
  }
}

export async function getAutoBookingSettings(shopId: number): Promise<AutoBookingSettings | null> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { autoBooking: 1, enabledFeatures: 1, billingStatus: 1, plan: 1 } }
  );
  
  if (!shop) return null;
  
  const rawFeatures = shop.enabledFeatures;
  const hasOilSticker = Array.isArray(rawFeatures) 
    ? rawFeatures.includes("oil_sticker")
    : (rawFeatures && typeof rawFeatures === "object" && (rawFeatures as any).oil_sticker === true);
  const isPaid = shop.billingStatus === "active" || shop.plan === "professional" || shop.plan === "enterprise";
  
  if (!isPaid || !hasOilSticker) return null;
  if (!shop.autoBooking?.enabled) return null;
  
  return shop.autoBooking as AutoBookingSettings;
}

export async function getExistingBookingsCount(shopId: number, dateStr: string): Promise<number> {
  const db = await getDb();
  const count = await db.collection("auto_booking_queue").countDocuments({
    shopId,
    scheduledDate: dateStr,
    status: { $in: ["pending", "confirmed", "sent"] },
  });
  return count;
}

export async function findAvailableSlot(
  shopId: number,
  targetDate: Date,
  settings: AutoBookingSettings,
  maxAttempts: number = 14
): Promise<ScheduleResult> {
  const attempts: BookingSlot[] = [];
  let currentDate = new Date(targetDate);
  currentDate.setDate(currentDate.getDate() - settings.leadTimeDays);
  
  for (let i = 0; i < maxAttempts; i++) {
    const dateStr = formatDate(currentDate);
    const time = getPreferredTime(settings);
    const datetime = new Date(`${dateStr}T${time}:00`);
    
    const slot: BookingSlot = {
      date: dateStr,
      time,
      datetime,
      available: true,
    };
    
    if (isWeekend(currentDate, settings)) {
      slot.available = false;
      slot.reason = getDayOfWeek(currentDate) === 6 ? "Saturday blocked" : "Sunday blocked";
    } else if (isHoliday(dateStr, settings)) {
      slot.available = false;
      slot.reason = "Holiday blocked";
    } else {
      const existingCount = await getExistingBookingsCount(shopId, dateStr);
      if (existingCount >= settings.maxBookingsPerDay) {
        slot.available = false;
        slot.reason = `Max bookings reached (${existingCount}/${settings.maxBookingsPerDay})`;
      }
    }
    
    attempts.push(slot);
    
    if (slot.available) {
      return {
        success: true,
        slot,
        attempts,
      };
    }
    
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return {
    success: false,
    error: `No available slot found within ${maxAttempts} days`,
    attempts,
  };
}

export interface QueuedBooking {
  shopId: number;
  customerId?: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  vehicleId?: string;
  vin?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  serviceType: string;
  serviceMileage?: number;
  scheduledDate: string;
  scheduledTime: string;
  status: "pending" | "confirmed" | "sent" | "failed" | "cancelled";
  confirmationMode: "auto" | "review";
  stickerGeneratedAt: Date;
  createdAt: Date;
  confirmedAt?: Date;
  sentAt?: Date;
  failedAt?: Date;
  failedReason?: string;
  externalAppointmentId?: string;
  provider?: string;
}

export async function queueBooking(
  shopId: number,
  settings: AutoBookingSettings,
  booking: Omit<QueuedBooking, "shopId" | "status" | "confirmationMode" | "createdAt">
): Promise<{ success: boolean; bookingId?: string; error?: string }> {
  const db = await getDb();
  
  const queuedBooking: QueuedBooking = {
    ...booking,
    shopId,
    status: settings.confirmationMode === "auto" ? "confirmed" : "pending",
    confirmationMode: settings.confirmationMode,
    createdAt: new Date(),
  };
  
  const result = await db.collection("auto_booking_queue").insertOne(queuedBooking);
  
  return {
    success: true,
    bookingId: result.insertedId.toString(),
  };
}

export async function getQueuedBookings(
  shopId: number,
  status?: string | string[]
): Promise<QueuedBooking[]> {
  const db = await getDb();
  
  const query: any = { shopId };
  if (status) {
    query.status = Array.isArray(status) ? { $in: status } : status;
  }
  
  const bookings = await db
    .collection("auto_booking_queue")
    .find(query)
    .sort({ scheduledDate: 1, scheduledTime: 1 })
    .limit(100)
    .toArray();
  
  return bookings as unknown as QueuedBooking[];
}

export async function confirmBooking(bookingId: string): Promise<boolean> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  
  const result = await db.collection("auto_booking_queue").updateOne(
    { _id: new ObjectId(bookingId), status: "pending" },
    { $set: { status: "confirmed", confirmedAt: new Date() } }
  );
  
  return result.modifiedCount > 0;
}

export async function cancelBooking(bookingId: string): Promise<boolean> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  
  const result = await db.collection("auto_booking_queue").updateOne(
    { _id: new ObjectId(bookingId), status: { $in: ["pending", "confirmed"] } },
    { $set: { status: "cancelled" } }
  );
  
  return result.modifiedCount > 0;
}

export async function markBookingSent(
  bookingId: string,
  externalAppointmentId: string,
  provider: string
): Promise<boolean> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  
  const result = await db.collection("auto_booking_queue").updateOne(
    { _id: new ObjectId(bookingId), status: "confirmed" },
    {
      $set: {
        status: "sent",
        sentAt: new Date(),
        externalAppointmentId,
        provider,
      },
    }
  );
  
  return result.modifiedCount > 0;
}

export async function markBookingFailed(
  bookingId: string,
  reason: string
): Promise<boolean> {
  const db = await getDb();
  const { ObjectId } = await import("mongodb");
  
  const result = await db.collection("auto_booking_queue").updateOne(
    { _id: new ObjectId(bookingId) },
    {
      $set: {
        status: "failed",
        failedAt: new Date(),
        failedReason: reason,
      },
    }
  );
  
  return result.modifiedCount > 0;
}
