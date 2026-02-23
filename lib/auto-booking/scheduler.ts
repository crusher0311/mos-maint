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
  maxBookingsPerSlot: number;
  appointmentDuration: 30 | 60;
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

// Helper to get timezone offset string like "-05:00" or "-06:00"
export function getTimezoneOffset(timezone: string, date: Date): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset'
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (tzPart?.value) {
      // Convert "GMT-5" or "GMT-6" to "-05:00" or "-06:00"
      const match = tzPart.value.match(/GMT([+-])(\d+)/);
      if (match) {
        const sign = match[1];
        const hours = match[2].padStart(2, '0');
        return `${sign}${hours}:00`;
      }
    }
  } catch (e) {
    console.error('[Auto Booking] Failed to get timezone offset:', e);
  }
  // Default to Central time offset
  return '-06:00';
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
  console.log(`[Auto Booking] isWeekend check: date=${date.toISOString()}, day=${day}, blockSaturday=${settings.blockSaturday}, blockSunday=${settings.blockSunday}`);
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
  
  if (!shop) {
    console.log(`[Auto Booking] Shop ${shopId} not found`);
    return null;
  }
  
  const rawFeatures = shop.enabledFeatures;
  const hasAutoBookingFeature = Array.isArray(rawFeatures) 
    ? rawFeatures.includes("auto_booking")
    : (rawFeatures && typeof rawFeatures === "object" && (rawFeatures as any).auto_booking === true);
  
  // Also allow if the shop has autoBooking settings enabled directly
  const hasAutoBookingEnabled = shop.autoBooking?.enabled === true;
  const hasAutoBooking = hasAutoBookingFeature || hasAutoBookingEnabled;
  
  // Allow if: has valid billing status/plan, OR if no billing status is set (dev/test environment)
  const hasNoBillingSet = !shop.billingStatus && !shop.plan;
  const isAllowed = hasNoBillingSet || 
    shop.billingStatus === "active" || shop.billingStatus === "trial" || shop.billingStatus === "demo" || 
    shop.plan === "professional" || shop.plan === "enterprise" || shop.plan === "trial" || shop.plan === "demo";
  
  console.log(`[Auto Booking] Shop ${shopId}: hasAutoBookingFeature=${hasAutoBookingFeature}, hasAutoBookingEnabled=${hasAutoBookingEnabled}, hasAutoBooking=${hasAutoBooking}, isAllowed=${isAllowed}, billingStatus=${shop.billingStatus}, plan=${shop.plan}`);
  
  if (!isAllowed || !hasAutoBooking) return null;
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
  const bookingId = result.insertedId.toString();
  
  // If auto mode, immediately push to SMS
  if (settings.confirmationMode === "auto") {
    console.log(`[Auto Booking] Auto mode - pushing booking ${bookingId} to SMS immediately`);
    
    // Update status to confirmed with timestamp
    await db.collection("auto_booking_queue").updateOne(
      { _id: result.insertedId },
      { $set: { confirmedAt: new Date() } }
    );
    
    // Get the inserted booking for SMS push
    const insertedBooking = await db.collection("auto_booking_queue").findOne({ _id: result.insertedId });
    if (insertedBooking) {
      const pushResult = await pushAppointmentToSMS(insertedBooking as QueuedBooking & { _id: any });
      
      if (pushResult.success) {
        await db.collection("auto_booking_queue").updateOne(
          { _id: result.insertedId },
          {
            $set: {
              status: "sent",
              sentAt: new Date(),
              externalAppointmentId: pushResult.externalId,
              provider: pushResult.provider,
            }
          }
        );
        console.log(`[Auto Booking] Auto mode - booking ${bookingId} sent to ${pushResult.provider}`);
      } else {
        await db.collection("auto_booking_queue").updateOne(
          { _id: result.insertedId },
          {
            $set: {
              failedAt: new Date(),
              failedReason: pushResult.error,
            }
          }
        );
        console.error(`[Auto Booking] Auto mode - failed to push ${bookingId}: ${pushResult.error}`);
      }
    }
  }
  
  return {
    success: true,
    bookingId,
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
  
  // First, get the booking and update status to confirmed
  const booking = await db.collection("auto_booking_queue").findOne({
    _id: new ObjectId(bookingId),
    status: "pending"
  });
  
  if (!booking) {
    console.log(`[Auto Booking] Booking ${bookingId} not found or not pending`);
    return false;
  }
  
  // Update status to confirmed
  const result = await db.collection("auto_booking_queue").updateOne(
    { _id: new ObjectId(bookingId), status: "pending" },
    { $set: { status: "confirmed", confirmedAt: new Date() } }
  );
  
  if (result.modifiedCount === 0) {
    return false;
  }
  
  // Now try to push the appointment to the SMS
  const pushResult = await pushAppointmentToSMS(booking as unknown as QueuedBooking & { _id: any });
  
  if (pushResult.success) {
    // Mark as sent
    await db.collection("auto_booking_queue").updateOne(
      { _id: new ObjectId(bookingId) },
      {
        $set: {
          status: "sent",
          sentAt: new Date(),
          externalAppointmentId: pushResult.externalId,
          provider: pushResult.provider,
        }
      }
    );
    console.log(`[Auto Booking] Booking ${bookingId} sent to ${pushResult.provider}, external ID: ${pushResult.externalId}`);
    return true;
  } else {
    // Mark as failed but keep confirmed status so user can retry
    await db.collection("auto_booking_queue").updateOne(
      { _id: new ObjectId(bookingId) },
      {
        $set: {
          failedAt: new Date(),
          failedReason: pushResult.error,
        }
      }
    );
    console.error(`[Auto Booking] Failed to push booking ${bookingId} to SMS: ${pushResult.error}`);
    // Return false to indicate the push failed (booking is confirmed but not synced)
    return false;
  }
}

async function pushAppointmentToSMS(
  booking: QueuedBooking & { _id: any }
): Promise<{ success: boolean; externalId?: string; provider?: string; error?: string }> {
  const db = await getDb();
  
  // Get shop details to determine which SMS to use
  const shop = await db.collection("shops").findOne(
    { shopId: booking.shopId },
    { projection: { integrations: 1, tekmetric: 1, protractor: 1, protractorConnectionId: 1, autoBooking: 1, timezone: 1 } }
  );
  
  if (!shop) {
    return { success: false, error: "Shop not found" };
  }
  
  const integrations = shop.integrations || [];
  // Check for Tekmetric: either in integrations array OR has a valid tekmetric.shopId
  const hasTekmetric = (integrations.includes("tekmetric") || shop.tekmetric?.shopId) && shop.tekmetric?.shopId;
  // Check for Protractor: either in integrations array OR has a valid connectionId
  const hasProtractor = (integrations.includes("protractor") || shop.protractor?.connectionId || shop.protractorConnectionId) && (shop.protractor?.connectionId || shop.protractorConnectionId);
  
  console.log(`[Auto Booking] Shop ${booking.shopId} SMS check:`, {
    integrations,
    hasTekmetric,
    tekmetricShopId: shop.tekmetric?.shopId,
    hasProtractor,
    protractorConnectionId: shop.protractor?.connectionId || shop.protractorConnectionId,
  });
  
  // Combine date and time to create appointment datetime
  // Tekmetric requires ZonedDateTime format - use shop's timezone offset
  // Default to Central time (America/Chicago) - most common for US auto shops
  // Format: 2026-04-23T08:00:00-05:00
  const shopTimezone = shop.timezone || 'America/Chicago';
  const autoBookingSettings = shop.autoBooking as AutoBookingSettings | undefined;
  const appointmentDuration = autoBookingSettings?.appointmentDuration || 60; // Default 60 minutes
  
  // Calculate timezone offset for the scheduled date
  const scheduledDateTime = new Date(`${booking.scheduledDate}T${booking.scheduledTime}:00`);
  const tzOffset = getTimezoneOffset(shopTimezone, scheduledDateTime);
  
  const startTimeStr = `${booking.scheduledDate}T${booking.scheduledTime}:00${tzOffset}`;
  const [hours, minutes] = booking.scheduledTime.split(':').map(Number);
  
  // Calculate end time based on appointment duration setting
  const totalMinutes = hours * 60 + minutes + appointmentDuration;
  const endHours = Math.floor(totalMinutes / 60);
  const endMinutes = totalMinutes % 60;
  const endTimeStr = `${booking.scheduledDate}T${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}:00${tzOffset}`;
  
  // Try Tekmetric first if available
  if (hasTekmetric) {
    try {
      const { createAppointment } = await import("@/lib/tekmetric");
      const tekmetricShopId = Number(shop.tekmetric.shopId);
      
      // Find both customer and vehicle IDs from cached data
      const { customerId: tekmetricCustomerId, vehicleId: tekmetricVehicleId } = 
        await findTekmetricCustomerAndVehicle(
          tekmetricShopId, 
          booking.customerId, 
          booking.customerName,
          booking.vehicleId,
          booking.vin
        );
      
      if (!tekmetricCustomerId) {
        console.log(`[Auto Booking] Could not find Tekmetric customer ID for ${booking.customerName}`);
        // Fall through to Protractor if available
      } else if (!tekmetricVehicleId) {
        console.log(`[Auto Booking] Could not find Tekmetric vehicle ID for ${booking.vin || booking.vehicleId}`);
        // Fall through to Protractor if available
      } else {
        let vYear = booking.vehicleYear;
        let vMake = booking.vehicleMake;
        let vModel = booking.vehicleModel;
        
        if (!vYear && !vMake && !vModel && tekmetricVehicleId) {
          try {
            const { getVehicle } = await import("@/lib/tekmetric");
            const vData = await getVehicle(tekmetricVehicleId, tekmetricShopId);
            if (vData) {
              vYear = vData.year;
              vMake = vData.make;
              vModel = vData.model;
              console.log(`[Auto Booking] Enriched vehicle from API: ${vYear} ${vMake} ${vModel}`);
            }
          } catch (e: any) {
            console.log(`[Auto Booking] Could not enrich vehicle details: ${e.message}`);
          }
        }
        
        const vehicleDesc = [vYear, vMake, vModel].filter(Boolean).join(' ') || 'Vehicle';
        const appointment = await createAppointment({
          shopId: Number(shop.tekmetric.shopId),
          customerId: tekmetricCustomerId,
          vehicleId: tekmetricVehicleId,
          startTime: startTimeStr,
          endTime: endTimeStr,
          title: `[MOS Auto Book] Oil Change - ${vehicleDesc}`,
          description: `Scheduled by MOS - ${booking.serviceType}`,
          color: "blue",
          dropoffTime: startTimeStr,
          pickupTime: endTimeStr,
          rideOption: "NONE",
        });
        
        return {
          success: true,
          externalId: String(appointment.id),
          provider: "tekmetric",
        };
      }
    } catch (err: any) {
      console.error(`[Auto Booking] Tekmetric appointment creation failed:`, err.message);
      // Fall through to Protractor if available
    }
  }
  
  // Try Protractor if available
  if (hasProtractor) {
    try {
      const { createProtractorAppointment } = await import("@/lib/integrations/protractor");
      
      // Look up Protractor contact and vehicle IDs dynamically
      const { contactId: protractorContactId, vehicleId: protractorVehicleId } = 
        await findProtractorContactAndVehicle(
          booking.shopId, 
          booking.customerId, 
          booking.vehicleId,
          booking.vin
        );
      
      if (!protractorContactId || !protractorVehicleId) {
        console.log(`[Auto Booking] Could not find Protractor contact/vehicle IDs for ${booking.vin || booking.vehicleId}`);
        return { 
          success: false, 
          error: "Could not find Protractor contact or vehicle - vehicle may not exist in Protractor yet" 
        };
      }
      
      const result = await createProtractorAppointment({
        shopId: booking.shopId,
        contactId: protractorContactId,
        vehicleId: protractorVehicleId,
        scheduledTime: startTimeStr,
        duration: appointmentDuration,
        notes: `[Appointment Type] Drop-off Vehicle - Oil Change - ${[booking.vehicleYear, booking.vehicleMake, booking.vehicleModel].filter(Boolean).join(' ') || 'Vehicle'}. Auto-booked via MOS.`,
      });
      
      if (result.ok && result.appointmentId) {
        return {
          success: true,
          externalId: result.appointmentId,
          provider: "protractor",
        };
      } else {
        return { success: false, error: result.error };
      }
    } catch (err: any) {
      console.error(`[Auto Booking] Protractor appointment creation failed:`, err.message);
      return { success: false, error: err.message };
    }
  }
  
  // No SMS integration - booking confirmed but will stay in local queue only
  console.log(`[Auto Booking] No SMS integration configured for shop ${booking.shopId}, booking will remain local only`);
  return { 
    success: true, 
    externalId: "local-only",
    provider: "none"
  };
}

export async function findTekmetricCustomerAndVehicle(
  tekmetricShopId: number,
  mosCustomerId?: string,
  customerName?: string,
  mosVehicleId?: string,
  vin?: string
): Promise<{ customerId: number | null; vehicleId: number | null }> {
  const db = await getDb();
  
  console.log(`[Auto Booking] findTekmetricCustomerAndVehicle: tekmetricShopId=${tekmetricShopId}, mosCustomerId=${mosCustomerId}, customerName=${customerName}, vin=${vin}`);
  
  let customerId: number | null = null;
  let vehicleId: number | null = null;
  
  // Try to parse as number directly (might already be Tekmetric ID)
  if (mosCustomerId) {
    const parsed = Number(mosCustomerId);
    if (!isNaN(parsed) && parsed > 0) {
      console.log(`[Auto Booking] Using customer ID directly as Tekmetric ID: ${parsed}`);
      customerId = parsed;
    }
  }
  
  if (mosVehicleId) {
    const parsed = Number(mosVehicleId);
    if (!isNaN(parsed) && parsed > 0) {
      console.log(`[Auto Booking] Using vehicle ID directly as Tekmetric ID: ${parsed}`);
      vehicleId = parsed;
    }
  }
  
  // If we already have both, return them
  if (customerId && vehicleId) {
    return { customerId, vehicleId };
  }
  
  // Try to find from repair order by VIN - this gives us both customer and vehicle
  if (vin) {
    const repairOrder = await db.collection("tekmetric_repair_orders").findOne({
      tekmetricShopId,
      "data.vehicle.vin": vin.toUpperCase()
    });
    
    if (repairOrder?.data) {
      if (!customerId && repairOrder.data.customer?.id) {
        console.log(`[Auto Booking] Found Tekmetric customer ${repairOrder.data.customer.id} from repair order by VIN`);
        customerId = repairOrder.data.customer.id;
      }
      if (!vehicleId && repairOrder.data.vehicle?.id) {
        console.log(`[Auto Booking] Found Tekmetric vehicle ${repairOrder.data.vehicle.id} from repair order by VIN`);
        vehicleId = repairOrder.data.vehicle.id;
      }
    }
  }
  
  // If still missing vehicle, check tekmetric_vehicles collection
  if (!vehicleId && vin) {
    const cachedVehicle = await db.collection("tekmetric_vehicles").findOne({
      tekmetricShopId,
      "data.vin": vin.toUpperCase()
    });
    
    if (cachedVehicle?.data?.id) {
      console.log(`[Auto Booking] Found Tekmetric vehicle ${cachedVehicle.data.id} from vehicles cache by VIN`);
      vehicleId = cachedVehicle.data.id;
      
      // If vehicle has customerId reference, use it
      if (!customerId && cachedVehicle.data.customerId) {
        customerId = cachedVehicle.data.customerId;
        console.log(`[Auto Booking] Found customer ${customerId} from vehicle record`);
      }
    }
  }
  
  // Fallback: Try API for vehicle if still missing
  if (!vehicleId && vin) {
    try {
      const { getVehicles } = await import("@/lib/tekmetric");
      const result = await getVehicles(tekmetricShopId, { search: vin.toUpperCase(), size: 5 });
      
      if (result.content && result.content.length > 0) {
        const match = result.content.find(v => v.vin?.toUpperCase() === vin.toUpperCase());
        if (match) {
          console.log(`[Auto Booking] Found Tekmetric vehicle ${match.id} via API for VIN "${vin}"`);
          vehicleId = match.id;
          if (!customerId && match.customerId) {
            customerId = match.customerId;
            console.log(`[Auto Booking] Found customer ${customerId} from vehicle API response`);
          }
        }
      }
    } catch (err: any) {
      console.error(`[Auto Booking] Tekmetric vehicle API search failed:`, err.message);
    }
  }
  
  return { customerId, vehicleId };
}

export async function findProtractorContactAndVehicle(
  shopId: number,
  mosContactId?: string,
  mosVehicleId?: string,
  vin?: string
): Promise<{ contactId: string | null; vehicleId: string | null }> {
  const db = await getDb();
  
  console.log(`[Auto Booking] findProtractorContactAndVehicle: shopId=${shopId}, mosContactId=${mosContactId}, mosVehicleId=${mosVehicleId}, vin=${vin}`);
  
  let contactId: string | null = null;
  let vehicleId: string | null = null;
  
  // If IDs are already provided and look like Protractor IDs (not MOS ObjectIds), use them
  if (mosContactId && mosContactId.length < 20) {
    contactId = mosContactId;
    console.log(`[Auto Booking] Using contact ID directly: ${contactId}`);
  }
  if (mosVehicleId && mosVehicleId.length < 20) {
    vehicleId = mosVehicleId;
    console.log(`[Auto Booking] Using vehicle ID directly: ${vehicleId}`);
  }
  
  if (contactId && vehicleId) {
    return { contactId, vehicleId };
  }
  
  // Look up from cached vehicle by VIN
  if (vin) {
    const cachedVehicle = await db.collection("protractor_vehicles").findOne({
      shopId,
      vin: vin.toUpperCase(),
    });
    
    if (cachedVehicle) {
      console.log(`[Auto Booking] Found Protractor vehicle in cache for VIN ${vin}:`, cachedVehicle.protractorId);
      if (!vehicleId && cachedVehicle.protractorId) {
        vehicleId = String(cachedVehicle.protractorId);
      }
      // Check for owner/contact on cached vehicle
      if (!contactId && cachedVehicle.data?.Owner?.ID) {
        contactId = String(cachedVehicle.data.Owner.ID);
        console.log(`[Auto Booking] Found contact from cached vehicle owner: ${contactId}`);
      }
    }
  }
  
  // Try to find from cached work orders if still missing
  if (!contactId || !vehicleId) {
    const recentRO = await db.collection("protractor_ro_cache").findOne(
      { 
        shopId, 
        "data.ServiceItem.VIN": vin?.toUpperCase() 
      },
      { sort: { "data.DateOut": -1 } }
    );
    
    if (recentRO) {
      console.log(`[Auto Booking] Found Protractor RO in cache for VIN ${vin}`);
      if (!vehicleId && recentRO.data?.ServiceItem?.ID) {
        vehicleId = String(recentRO.data.ServiceItem.ID);
        console.log(`[Auto Booking] Found vehicle ID from RO: ${vehicleId}`);
      }
      if (!contactId && recentRO.data?.Contact?.ID) {
        contactId = String(recentRO.data.Contact.ID);
        console.log(`[Auto Booking] Found contact ID from RO: ${contactId}`);
      }
    }
  }
  
  // If we still don't have IDs, try to fetch from Protractor API
  if ((!contactId || !vehicleId) && vin) {
    try {
      const { fetchVehicleByVin } = await import("@/lib/integrations/protractor");
      const result = await fetchVehicleByVin(shopId, vin);
      
      if (result.ok && result.vehicle) {
        console.log(`[Auto Booking] Found Protractor vehicle from API for VIN ${vin}`);
        if (!vehicleId) {
          vehicleId = String(result.vehicle.ID);
        }
        if (!contactId && result.vehicle.Owner?.ID) {
          contactId = String(result.vehicle.Owner.ID);
        }
      }
    } catch (err: any) {
      console.error(`[Auto Booking] Protractor vehicle API lookup failed:`, err.message);
    }
  }
  
  console.log(`[Auto Booking] Protractor lookup result: contactId=${contactId}, vehicleId=${vehicleId}`);
  return { contactId, vehicleId };
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
  console.log(`[Auto Booking] findAvailableSlotFromDate: starting from ${startDate.toISOString()}`);
  
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
      console.log(`[Auto Booking] Slot ${dateStr}: ${slot.reason}`);
    } else if (isHoliday(dateStr, settings)) {
      slot.available = false;
      slot.reason = "Holiday blocked";
      console.log(`[Auto Booking] Slot ${dateStr}: ${slot.reason}`);
    } else {
      const existingCount = await getExistingBookingsCount(shopId, dateStr);
      if (existingCount >= settings.maxBookingsPerDay) {
        slot.available = false;
        slot.reason = `Max bookings reached (${existingCount}/${settings.maxBookingsPerDay})`;
        console.log(`[Auto Booking] Slot ${dateStr}: ${slot.reason}`);
      } else {
        console.log(`[Auto Booking] Slot ${dateStr}: AVAILABLE (existing=${existingCount}, max=${settings.maxBookingsPerDay})`);
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
): Promise<{ queued: boolean; bookingId?: string; status?: string; error?: string; scheduledDate?: string; updated?: boolean; skipped?: boolean }> {
  try {
    const settings = await getAutoBookingSettings(shopId);
    
    if (!settings || !settings.enabled) {
      return { queued: false, error: "Auto booking not enabled" };
    }
    
    if (!data.customerName && !data.customerId) {
      return { queued: false, error: "Customer info required for booking" };
    }

    const db = await getDb();

    const existingQuery: any = {
      shopId,
      status: { $in: ["pending", "confirmed", "sent"] },
    };
    if (data.vin) {
      existingQuery.vin = data.vin;
    } else if (data.vehicleId) {
      existingQuery.vehicleId = data.vehicleId;
    } else if (data.customerId) {
      existingQuery.customerId = data.customerId;
    }

    const existingBooking = await db.collection("auto_booking_queue").findOne(
      existingQuery,
      { sort: { createdAt: -1 } }
    );

    if (existingBooking) {
      const stickerDate = new Date(nextServiceDate);
      const bookingTarget = new Date(stickerDate);
      bookingTarget.setDate(bookingTarget.getDate() - settings.leadTimeDays);
      const targetDateStr = formatDate(bookingTarget);

      if (existingBooking.scheduledDate === targetDateStr || existingBooking.scheduledDate === nextServiceDate) {
        console.log(`[Auto Booking] Duplicate detected for shop ${shopId}, VIN ${data.vin || 'N/A'} — existing booking ${existingBooking._id} already scheduled for ${existingBooking.scheduledDate}. Skipping.`);
        return {
          queued: false,
          bookingId: existingBooking._id.toString(),
          status: existingBooking.status,
          scheduledDate: existingBooking.scheduledDate,
          skipped: true,
        };
      }

      console.log(`[Auto Booking] Service date changed for shop ${shopId}, VIN ${data.vin || 'N/A'} — old scheduled: ${existingBooking.scheduledDate}, new target: ${targetDateStr}. Updating booking.`);

      const slotResult = await findAvailableSlotFromDate(shopId, bookingTarget, settings);

      if (!slotResult.success || !slotResult.slot) {
        return { queued: false, error: slotResult.error || "No available slot near new service date" };
      }

      await db.collection("auto_booking_queue").updateOne(
        { _id: existingBooking._id },
        {
          $set: {
            scheduledDate: slotResult.slot.date,
            scheduledTime: slotResult.slot.time,
            serviceMileage: nextServiceMileage,
            stickerGeneratedAt: new Date(),
            updatedAt: new Date(),
            status: settings.confirmationMode === "auto" ? "confirmed" : "pending",
            ...(existingBooking.status === "sent" ? { previousExternalId: existingBooking.externalAppointmentId, previousScheduledDate: existingBooking.scheduledDate } : {}),
          },
          $unset: {
            ...(existingBooking.status === "sent" ? { sentAt: "", externalAppointmentId: "" } : {}),
            failedAt: "",
            failedReason: "",
          },
        }
      );

      if (settings.confirmationMode === "auto") {
        const updatedBooking = await db.collection("auto_booking_queue").findOne({ _id: existingBooking._id });
        if (updatedBooking) {
          const pushResult = await pushAppointmentToSMS(updatedBooking as QueuedBooking & { _id: any });
          if (pushResult.success) {
            await db.collection("auto_booking_queue").updateOne(
              { _id: existingBooking._id },
              {
                $set: {
                  status: "sent",
                  sentAt: new Date(),
                  externalAppointmentId: pushResult.externalId,
                  provider: pushResult.provider,
                },
              }
            );
            console.log(`[Auto Booking] Updated booking ${existingBooking._id} re-sent to ${pushResult.provider}`);
          } else {
            console.error(`[Auto Booking] Updated booking ${existingBooking._id} failed to re-send: ${pushResult.error}`);
          }
        }
      }

      console.log(`[Auto Booking] Updated existing booking ${existingBooking._id} to new date ${slotResult.slot.date}`);
      return {
        queued: true,
        bookingId: existingBooking._id.toString(),
        status: settings.confirmationMode === "auto" ? "confirmed" : "pending",
        scheduledDate: slotResult.slot.date,
        updated: true,
      };
    }
    
    // Apply lead time: schedule the appointment leadTimeDays before the service due date
    const stickerDate = new Date(nextServiceDate);
    const bookingTarget = new Date(stickerDate);
    bookingTarget.setDate(bookingTarget.getDate() - settings.leadTimeDays);
    
    console.log(`[Auto Booking] Service due: ${nextServiceDate}, lead time: ${settings.leadTimeDays} days, booking target: ${formatDate(bookingTarget)}`);
    
    // Find available slot starting from the lead-time-adjusted date
    const slotResult = await findAvailableSlotFromDate(shopId, bookingTarget, settings);
    
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
