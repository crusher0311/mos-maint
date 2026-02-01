import sql from "@/lib/db/postgres";

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

export function getTimezoneOffset(timezone: string, date: Date): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'shortOffset'
    });
    const parts = formatter.formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (tzPart?.value) {
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
  const shopIdStr = String(shopId);
  
  const rows = await sql`
    SELECT settings, enabled_features, billing_status, plan
    FROM shops
    WHERE shop_id = ${shopIdStr}
    LIMIT 1
  `;
  
  const shop = rows[0];
  if (!shop) {
    console.log(`[Auto Booking] Shop ${shopId} not found`);
    return null;
  }
  
  const settings = shop.settings as Record<string, unknown> | null;
  const autoBooking = settings?.autoBooking as AutoBookingSettings | undefined;
  const rawFeatures = shop.enabled_features;
  
  const hasAutoBookingFeature = Array.isArray(rawFeatures) 
    ? rawFeatures.includes("auto_booking")
    : (rawFeatures && typeof rawFeatures === "object" && (rawFeatures as any).auto_booking === true);
  
  const hasAutoBookingEnabled = autoBooking?.enabled === true;
  const hasAutoBooking = hasAutoBookingFeature || hasAutoBookingEnabled;
  
  const hasNoBillingSet = !shop.billing_status && !shop.plan;
  const isAllowed = hasNoBillingSet || 
    shop.billing_status === "active" || shop.billing_status === "trial" || shop.billing_status === "demo" || 
    shop.plan === "professional" || shop.plan === "enterprise" || shop.plan === "trial" || shop.plan === "demo";
  
  console.log(`[Auto Booking] Shop ${shopId}: hasAutoBookingFeature=${hasAutoBookingFeature}, hasAutoBookingEnabled=${hasAutoBookingEnabled}, hasAutoBooking=${hasAutoBooking}, isAllowed=${isAllowed}, billingStatus=${shop.billing_status}, plan=${shop.plan}`);
  
  if (!isAllowed || !hasAutoBooking) return null;
  if (!autoBooking?.enabled) return null;
  
  return autoBooking;
}

export async function getExistingBookingsCount(shopId: number, dateStr: string): Promise<number> {
  const shopIdStr = String(shopId);
  
  const rows = await sql`
    SELECT COUNT(*) as count
    FROM auto_booking_queue abq
    JOIN shops s ON abq.shop_id = s.id
    WHERE s.shop_id = ${shopIdStr}
      AND DATE(abq.scheduled_date) = ${dateStr}::date
      AND abq.status IN ('pending', 'confirmed', 'sent')
  `;
  
  return Number(rows[0]?.count || 0);
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
  id?: string;
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
  booking: Omit<QueuedBooking, "shopId" | "status" | "confirmationMode" | "createdAt" | "id">
): Promise<{ success: boolean; bookingId?: string; error?: string }> {
  const shopIdStr = String(shopId);
  
  const status = settings.confirmationMode === "auto" ? "confirmed" : "pending";
  
  const metadata = {
    customerName: booking.customerName,
    customerPhone: booking.customerPhone,
    customerEmail: booking.customerEmail,
    vin: booking.vin,
    vehicleYear: booking.vehicleYear,
    vehicleMake: booking.vehicleMake,
    vehicleModel: booking.vehicleModel,
    serviceType: booking.serviceType,
    serviceMileage: booking.serviceMileage,
    scheduledTime: booking.scheduledTime,
    confirmationMode: settings.confirmationMode,
    stickerGeneratedAt: booking.stickerGeneratedAt,
  };
  
  const rows = await sql`
    INSERT INTO auto_booking_queue (shop_id, customer_id, vehicle_id, status, scheduled_date, metadata, created_at, updated_at)
    SELECT 
      s.id,
      ${booking.customerId ? sql`(SELECT id FROM customers WHERE external_id = ${booking.customerId} LIMIT 1)` : sql`NULL`},
      ${booking.vehicleId ? sql`(SELECT id FROM vehicles WHERE external_id = ${booking.vehicleId} LIMIT 1)` : sql`NULL`},
      ${status},
      ${booking.scheduledDate}::timestamp,
      ${JSON.stringify(metadata)}::jsonb,
      NOW(),
      NOW()
    FROM shops s
    WHERE s.shop_id = ${shopIdStr}
    RETURNING id
  `;
  
  const bookingId = rows[0]?.id;
  
  if (!bookingId) {
    return { success: false, error: "Failed to create booking" };
  }
  
  if (settings.confirmationMode === "auto") {
    console.log(`[Auto Booking] Auto mode - pushing booking ${bookingId} to SMS immediately`);
    
    await sql`
      UPDATE auto_booking_queue
      SET metadata = metadata || '{"confirmedAt": "${new Date().toISOString()}"}'::jsonb
      WHERE id = ${bookingId}
    `;
    
    const queuedBooking: QueuedBooking = {
      id: bookingId,
      shopId,
      ...booking,
      status: "confirmed",
      confirmationMode: settings.confirmationMode,
      createdAt: new Date(),
    };
    
    const pushResult = await pushAppointmentToSMS(queuedBooking);
    
    if (pushResult.success) {
      await sql`
        UPDATE auto_booking_queue
        SET 
          status = 'sent',
          metadata = metadata || ${JSON.stringify({
            sentAt: new Date().toISOString(),
            externalAppointmentId: pushResult.externalId,
            provider: pushResult.provider,
          })}::jsonb,
          updated_at = NOW()
        WHERE id = ${bookingId}
      `;
      console.log(`[Auto Booking] Auto mode - booking ${bookingId} sent to ${pushResult.provider}`);
    } else {
      await sql`
        UPDATE auto_booking_queue
        SET metadata = metadata || ${JSON.stringify({
          failedAt: new Date().toISOString(),
          failedReason: pushResult.error,
        })}::jsonb
        WHERE id = ${bookingId}
      `;
      console.error(`[Auto Booking] Auto mode - failed to push ${bookingId}: ${pushResult.error}`);
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
  const shopIdStr = String(shopId);
  
  let rows;
  
  if (status) {
    const statusArray = Array.isArray(status) ? status : [status];
    rows = await sql`
      SELECT abq.id, abq.status, abq.scheduled_date, abq.metadata, abq.created_at,
             c.external_id as customer_external_id,
             v.external_id as vehicle_external_id
      FROM auto_booking_queue abq
      JOIN shops s ON abq.shop_id = s.id
      LEFT JOIN customers c ON abq.customer_id = c.id
      LEFT JOIN vehicles v ON abq.vehicle_id = v.id
      WHERE s.shop_id = ${shopIdStr}
        AND abq.status = ANY(${statusArray})
      ORDER BY abq.scheduled_date ASC
      LIMIT 100
    `;
  } else {
    rows = await sql`
      SELECT abq.id, abq.status, abq.scheduled_date, abq.metadata, abq.created_at,
             c.external_id as customer_external_id,
             v.external_id as vehicle_external_id
      FROM auto_booking_queue abq
      JOIN shops s ON abq.shop_id = s.id
      LEFT JOIN customers c ON abq.customer_id = c.id
      LEFT JOIN vehicles v ON abq.vehicle_id = v.id
      WHERE s.shop_id = ${shopIdStr}
      ORDER BY abq.scheduled_date ASC
      LIMIT 100
    `;
  }
  
  return rows.map(row => {
    const metadata = (row.metadata || {}) as Record<string, unknown>;
    return {
      id: row.id as string,
      shopId,
      customerId: row.customer_external_id as string | undefined,
      customerName: metadata.customerName as string || "",
      customerPhone: metadata.customerPhone as string | undefined,
      customerEmail: metadata.customerEmail as string | undefined,
      vehicleId: row.vehicle_external_id as string | undefined,
      vin: metadata.vin as string | undefined,
      vehicleYear: metadata.vehicleYear as number | undefined,
      vehicleMake: metadata.vehicleMake as string | undefined,
      vehicleModel: metadata.vehicleModel as string | undefined,
      serviceType: metadata.serviceType as string || "Oil Change",
      serviceMileage: metadata.serviceMileage as number | undefined,
      scheduledDate: row.scheduled_date ? new Date(row.scheduled_date as string).toISOString().split('T')[0] : "",
      scheduledTime: metadata.scheduledTime as string || "08:00",
      status: row.status as QueuedBooking["status"],
      confirmationMode: metadata.confirmationMode as "auto" | "review" || "review",
      stickerGeneratedAt: metadata.stickerGeneratedAt ? new Date(metadata.stickerGeneratedAt as string) : new Date(),
      createdAt: new Date(row.created_at as string),
      confirmedAt: metadata.confirmedAt ? new Date(metadata.confirmedAt as string) : undefined,
      sentAt: metadata.sentAt ? new Date(metadata.sentAt as string) : undefined,
      failedAt: metadata.failedAt ? new Date(metadata.failedAt as string) : undefined,
      failedReason: metadata.failedReason as string | undefined,
      externalAppointmentId: metadata.externalAppointmentId as string | undefined,
      provider: metadata.provider as string | undefined,
    };
  });
}

export async function confirmBooking(bookingId: string): Promise<boolean> {
  const rows = await sql`
    SELECT abq.id, abq.metadata, s.shop_id
    FROM auto_booking_queue abq
    JOIN shops s ON abq.shop_id = s.id
    WHERE abq.id = ${bookingId}
      AND abq.status = 'pending'
    LIMIT 1
  `;
  
  const booking = rows[0];
  if (!booking) {
    console.log(`[Auto Booking] Booking ${bookingId} not found or not pending`);
    return false;
  }
  
  const result = await sql`
    UPDATE auto_booking_queue
    SET 
      status = 'confirmed',
      metadata = metadata || '{"confirmedAt": "${new Date().toISOString()}"}'::jsonb,
      updated_at = NOW()
    WHERE id = ${bookingId}
      AND status = 'pending'
  `;
  
  if (result.count === 0) {
    return false;
  }
  
  const metadata = (booking.metadata || {}) as Record<string, unknown>;
  const queuedBooking: QueuedBooking = {
    id: bookingId,
    shopId: parseInt(booking.shop_id as string),
    customerName: metadata.customerName as string || "",
    customerPhone: metadata.customerPhone as string | undefined,
    customerEmail: metadata.customerEmail as string | undefined,
    vin: metadata.vin as string | undefined,
    vehicleYear: metadata.vehicleYear as number | undefined,
    vehicleMake: metadata.vehicleMake as string | undefined,
    vehicleModel: metadata.vehicleModel as string | undefined,
    serviceType: metadata.serviceType as string || "Oil Change",
    serviceMileage: metadata.serviceMileage as number | undefined,
    scheduledDate: "",
    scheduledTime: metadata.scheduledTime as string || "08:00",
    status: "confirmed",
    confirmationMode: metadata.confirmationMode as "auto" | "review" || "review",
    stickerGeneratedAt: new Date(),
    createdAt: new Date(),
  };
  
  const pushResult = await pushAppointmentToSMS(queuedBooking);
  
  if (pushResult.success) {
    await sql`
      UPDATE auto_booking_queue
      SET 
        status = 'sent',
        metadata = metadata || ${JSON.stringify({
          sentAt: new Date().toISOString(),
          externalAppointmentId: pushResult.externalId,
          provider: pushResult.provider,
        })}::jsonb,
        updated_at = NOW()
      WHERE id = ${bookingId}
    `;
    console.log(`[Auto Booking] Booking ${bookingId} sent to ${pushResult.provider}, external ID: ${pushResult.externalId}`);
    return true;
  } else {
    await sql`
      UPDATE auto_booking_queue
      SET metadata = metadata || ${JSON.stringify({
        failedAt: new Date().toISOString(),
        failedReason: pushResult.error,
      })}::jsonb
      WHERE id = ${bookingId}
    `;
    console.error(`[Auto Booking] Failed to push booking ${bookingId} to SMS: ${pushResult.error}`);
    return false;
  }
}

async function pushAppointmentToSMS(
  booking: QueuedBooking
): Promise<{ success: boolean; externalId?: string; provider?: string; error?: string }> {
  const shopIdStr = String(booking.shopId);
  
  const rows = await sql`
    SELECT id, settings, tekmetric_shop_id, protractor_connection_id, timezone
    FROM shops
    WHERE shop_id = ${shopIdStr}
    LIMIT 1
  `;
  
  const shop = rows[0];
  if (!shop) {
    return { success: false, error: "Shop not found" };
  }
  
  const settings = shop.settings as Record<string, unknown> | null;
  const integrations = (settings?.integrations || []) as string[];
  const tekmetric = settings?.tekmetric as Record<string, unknown> | undefined;
  const protractor = settings?.protractor as Record<string, unknown> | undefined;
  
  const hasTekmetric = (integrations.includes("tekmetric") || tekmetric?.shopId || shop.tekmetric_shop_id) && (tekmetric?.shopId || shop.tekmetric_shop_id);
  const hasProtractor = (integrations.includes("protractor") || protractor?.connectionId || shop.protractor_connection_id) && (protractor?.connectionId || shop.protractor_connection_id);
  
  console.log(`[Auto Booking] Shop ${booking.shopId} SMS check:`, {
    integrations,
    hasTekmetric,
    tekmetricShopId: tekmetric?.shopId || shop.tekmetric_shop_id,
    hasProtractor,
    protractorConnectionId: protractor?.connectionId || shop.protractor_connection_id,
  });
  
  const shopTimezone = (shop.timezone as string) || 'America/Chicago';
  const autoBookingSettings = settings?.autoBooking as AutoBookingSettings | undefined;
  const appointmentDuration = autoBookingSettings?.appointmentDuration || 60;
  
  const scheduledDateTime = new Date(`${booking.scheduledDate}T${booking.scheduledTime}:00`);
  const tzOffset = getTimezoneOffset(shopTimezone, scheduledDateTime);
  
  const startTimeStr = `${booking.scheduledDate}T${booking.scheduledTime}:00${tzOffset}`;
  const [hours, minutes] = booking.scheduledTime.split(':').map(Number);
  
  const totalMinutes = hours * 60 + minutes + appointmentDuration;
  const endHours = Math.floor(totalMinutes / 60);
  const endMinutes = totalMinutes % 60;
  const endTimeStr = `${booking.scheduledDate}T${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}:00${tzOffset}`;
  
  if (hasTekmetric) {
    try {
      const { createAppointment } = await import("@/lib/tekmetric");
      const tekmetricShopId = Number(tekmetric?.shopId || shop.tekmetric_shop_id);
      
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
      } else if (!tekmetricVehicleId) {
        console.log(`[Auto Booking] Could not find Tekmetric vehicle ID for ${booking.vin || booking.vehicleId}`);
      } else {
        const appointment = await createAppointment({
          shopId: tekmetricShopId,
          customerId: tekmetricCustomerId,
          vehicleId: tekmetricVehicleId,
          startTime: startTimeStr,
          endTime: endTimeStr,
          title: `[MOS Auto Book] Oil Change - ${booking.vehicleYear} ${booking.vehicleMake} ${booking.vehicleModel}`,
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
    }
  }
  
  if (hasProtractor) {
    try {
      const { createProtractorAppointment } = await import("@/lib/integrations/protractor");
      
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
        notes: `[Appointment Type] Drop-off Vehicle - Oil Change - ${booking.vehicleYear} ${booking.vehicleMake} ${booking.vehicleModel}. Auto-booked via MOS.`,
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
  console.log(`[Auto Booking] findTekmetricCustomerAndVehicle: tekmetricShopId=${tekmetricShopId}, mosCustomerId=${mosCustomerId}, customerName=${customerName}, vin=${vin}`);
  
  let customerId: number | null = null;
  let vehicleId: number | null = null;
  
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
  
  if (customerId && vehicleId) {
    return { customerId, vehicleId };
  }
  
  if (vin) {
    const rows = await sql`
      SELECT data
      FROM tekmetric_work_orders
      WHERE tekmetric_shop_id = ${tekmetricShopId}
        AND data->'vehicle'->>'vin' = ${vin.toUpperCase()}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    
    if (rows[0]?.data) {
      const data = rows[0].data as Record<string, any>;
      if (!customerId && data.customer?.id) {
        console.log(`[Auto Booking] Found Tekmetric customer ${data.customer.id} from repair order by VIN`);
        customerId = data.customer.id;
      }
      if (!vehicleId && data.vehicle?.id) {
        console.log(`[Auto Booking] Found Tekmetric vehicle ${data.vehicle.id} from repair order by VIN`);
        vehicleId = data.vehicle.id;
      }
    }
  }
  
  if (!vehicleId && vin) {
    const rows = await sql`
      SELECT data
      FROM tekmetric_vehicles
      WHERE tekmetric_shop_id = ${tekmetricShopId}
        AND data->>'vin' = ${vin.toUpperCase()}
      LIMIT 1
    `;
    
    if (rows[0]?.data) {
      const data = rows[0].data as Record<string, any>;
      if (data.id) {
        console.log(`[Auto Booking] Found Tekmetric vehicle ${data.id} from vehicles cache by VIN`);
        vehicleId = data.id;
        
        if (!customerId && data.customerId) {
          customerId = data.customerId;
          console.log(`[Auto Booking] Found customer ${customerId} from vehicle record`);
        }
      }
    }
  }
  
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
  console.log(`[Auto Booking] findProtractorContactAndVehicle: shopId=${shopId}, mosContactId=${mosContactId}, mosVehicleId=${mosVehicleId}, vin=${vin}`);
  
  let contactId: string | null = null;
  let vehicleId: string | null = null;
  
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
  
  if (vin) {
    const rows = await sql`
      SELECT protractor_id, data
      FROM protractor_vehicles
      WHERE shop_id = ${shopId}
        AND vin = ${vin.toUpperCase()}
      LIMIT 1
    `;
    
    if (rows[0]) {
      console.log(`[Auto Booking] Found Protractor vehicle in cache for VIN ${vin}:`, rows[0].protractor_id);
      if (!vehicleId && rows[0].protractor_id) {
        vehicleId = String(rows[0].protractor_id);
      }
      const data = rows[0].data as Record<string, any> | null;
      if (!contactId && data?.Owner?.ID) {
        contactId = String(data.Owner.ID);
        console.log(`[Auto Booking] Found contact from cached vehicle owner: ${contactId}`);
      }
    }
  }
  
  if (!contactId || !vehicleId) {
    const rows = await sql`
      SELECT data
      FROM protractor_work_orders
      WHERE shop_id = ${shopId}
        AND data->'ServiceItem'->>'VIN' = ${vin?.toUpperCase() || ''}
      ORDER BY data->>'DateOut' DESC
      LIMIT 1
    `;
    
    if (rows[0]) {
      console.log(`[Auto Booking] Found Protractor RO in cache for VIN ${vin}`);
      const data = rows[0].data as Record<string, any>;
      if (!vehicleId && data?.ServiceItem?.ID) {
        vehicleId = String(data.ServiceItem.ID);
        console.log(`[Auto Booking] Found vehicle ID from RO: ${vehicleId}`);
      }
      if (!contactId && data?.Contact?.ID) {
        contactId = String(data.Contact.ID);
        console.log(`[Auto Booking] Found contact ID from RO: ${contactId}`);
      }
    }
  }
  
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
  const result = await sql`
    UPDATE auto_booking_queue
    SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${bookingId}
      AND status IN ('pending', 'confirmed')
  `;
  
  return result.count > 0;
}

export async function markBookingSent(
  bookingId: string,
  externalAppointmentId: string,
  provider: string
): Promise<boolean> {
  const result = await sql`
    UPDATE auto_booking_queue
    SET 
      status = 'sent',
      metadata = metadata || ${JSON.stringify({
        sentAt: new Date().toISOString(),
        externalAppointmentId,
        provider,
      })}::jsonb,
      updated_at = NOW()
    WHERE id = ${bookingId}
      AND status = 'confirmed'
  `;
  
  return result.count > 0;
}

export async function markBookingFailed(
  bookingId: string,
  reason: string
): Promise<boolean> {
  const result = await sql`
    UPDATE auto_booking_queue
    SET 
      status = 'failed',
      metadata = metadata || ${JSON.stringify({
        failedAt: new Date().toISOString(),
        failedReason: reason,
      })}::jsonb,
      updated_at = NOW()
    WHERE id = ${bookingId}
  `;
  
  return result.count > 0;
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
): Promise<{ queued: boolean; bookingId?: string; status?: string; error?: string; scheduledDate?: string }> {
  try {
    const settings = await getAutoBookingSettings(shopId);
    
    if (!settings || !settings.enabled) {
      return { queued: false, error: "Auto booking not enabled" };
    }
    
    if (!data.customerName && !data.customerId) {
      return { queued: false, error: "Customer info required for booking" };
    }
    
    const stickerDate = new Date(nextServiceDate);
    
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
