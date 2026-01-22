import { getDb } from "@/lib/mongo";

export interface AutoBookingSettings {
  enabled: boolean;
  leadTimeDays: number;
  blockSaturday: boolean;
  blockSunday: boolean;
  blockHolidays: boolean;
  useDefaultHolidays: boolean;
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

const US_HOLIDAYS = new Set([
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-07-04",
  "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-03",
  "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
]);

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
  
  if (settings.useDefaultHolidays && US_HOLIDAYS.has(dateStr)) {
    return true;
  }
  
  if (settings.customHolidays.some(h => h.date === dateStr)) {
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

export interface StickerBookingData {
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  vehicleId?: string;
  vin?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  roNumber?: string;
}

export async function findAvailableSlotFromDate(
  shopId: number,
  startDate: Date,
  settings: AutoBookingSettings,
  maxAttempts: number = 14
): Promise<ScheduleResult> {
  const attempts: BookingSlot[] = [];
  let currentDate = new Date(startDate);
  
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

export async function triggerAutoBookingFromSticker(
  shopId: number,
  nextServiceDate: string,
  nextServiceMileage: number,
  data: StickerBookingData
): Promise<{ queued: boolean; bookingId?: string; status?: string; error?: string; scheduledDate?: string }> {
  try {
    const settings = await getAutoBookingSettings(shopId);
    
    if (!settings || !settings.enabled) {
      return { queued: false, error: "Auto booking not enabled" };
    }
    
    if (!data.customerName && !data.customerId) {
      return { queued: false, error: "Customer info required for booking" };
    }
    
    // Use the sticker's nextServiceDate directly as the target booking date
    const stickerDate = new Date(nextServiceDate);
    
    // Find available slot starting from the sticker date (no leadTimeDays shift)
    const slotResult = await findAvailableSlotFromDate(shopId, stickerDate, settings);
    
    if (!slotResult.success || !slotResult.slot) {
      return { queued: false, error: slotResult.error || "No available slot near service date" };
    }
    
    const result = await queueBooking(shopId, settings, {
      customerId: data.customerId,
      customerName: data.customerName || "Unknown Customer",
      customerPhone: data.customerPhone,
      customerEmail: data.customerEmail,
      vehicleId: data.vehicleId,
      vin: data.vin,
      vehicleYear: data.vehicleYear,
      vehicleMake: data.vehicleMake,
      vehicleModel: data.vehicleModel,
      serviceType: "Oil Change",
      serviceMileage: nextServiceMileage,
      scheduledDate: slotResult.slot.date,
      scheduledTime: slotResult.slot.time,
      stickerGeneratedAt: new Date(),
    });
    
    if (result.success) {
      console.log(`[Auto Booking] Queued booking for shop ${shopId}: ${result.bookingId}, date=${slotResult.slot.date}, status=${settings.confirmationMode === "auto" ? "confirmed" : "pending"}`);
      return { 
        queued: true, 
        bookingId: result.bookingId,
        status: settings.confirmationMode === "auto" ? "confirmed" : "pending",
        scheduledDate: slotResult.slot.date,
      };
    }
    
    return { queued: false, error: result.error };
  } catch (err: any) {
    console.error("[Auto Booking] Trigger error:", err);
    return { queued: false, error: err.message };
  }
}
