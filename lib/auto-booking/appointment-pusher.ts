import { getDb } from "@/lib/mongo";
import { getSMSAdapter } from "@/lib/sms-adapter";
import { ObjectId } from "mongodb";

export interface BookingQueueItem {
  _id: ObjectId;
  shopId: number;
  vehicleId?: string;
  customerId?: string;
  vin?: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  vehicleYear?: number;
  vehicleMake?: string;
  vehicleModel?: string;
  serviceType: string;
  serviceMileage?: number;
  scheduledDate: string;
  scheduledTime: string;
  status: "pending" | "confirmed" | "sent" | "cancelled" | "failed";
  confirmationMode: "auto" | "review";
  stickerGeneratedAt?: Date;
  createdAt: Date;
  confirmedAt?: Date;
  sentAt?: Date;
  externalAppointmentId?: string;
  provider?: string;
  failedAt?: Date;
  failedReason?: string;
}

export interface PushResult {
  success: boolean;
  bookingId: string;
  smsAppointmentId?: string;
  error?: string;
}

export async function pushConfirmedBooking(
  shopId: number,
  bookingId: string
): Promise<PushResult> {
  const db = await getDb();
  
  const booking = await db.collection<BookingQueueItem>("auto_booking_queue").findOne({
    _id: new ObjectId(bookingId),
    shopId,
  });

  if (!booking) {
    return { success: false, bookingId, error: "Booking not found" };
  }

  if (booking.status !== "confirmed") {
    return { success: false, bookingId, error: `Cannot push booking with status: ${booking.status}` };
  }

  const adapter = await getSMSAdapter(shopId);
  if (!adapter) {
    return { success: false, bookingId, error: "No SMS system configured for this shop" };
  }

  if (!adapter.createAppointment) {
    return { success: false, bookingId, error: `${adapter.provider} does not support appointment creation` };
  }

  if (!booking.vehicleId || !booking.customerId) {
    return { 
      success: false, 
      bookingId, 
      error: "Missing vehicle or customer ID - cannot create appointment" 
    };
  }

  const vehicleDescription = [booking.vehicleYear, booking.vehicleMake, booking.vehicleModel]
    .filter(Boolean)
    .join(" ") || "Vehicle";

  try {
    const result = await adapter.createAppointment(shopId, {
      vehicleId: booking.vehicleId,
      customerId: booking.customerId,
      scheduledDate: booking.scheduledDate,
      scheduledTime: booking.scheduledTime,
      serviceDescription: booking.serviceType || "Oil Change Service",
      notes: `Auto-booked via MOS for ${vehicleDescription}. Customer: ${booking.customerName}`,
    });

    if (!result.ok || !result.appointment) {
      await db.collection("auto_booking_queue").updateOne(
        { _id: booking._id },
        {
          $set: {
            status: "failed",
            error: result.error || "Failed to create appointment",
            updatedAt: new Date(),
          },
        }
      );
      return { success: false, bookingId, error: result.error };
    }

    await db.collection("auto_booking_queue").updateOne(
      { _id: booking._id },
      {
        $set: {
          status: "sent",
          smsAppointmentId: result.appointment.id,
          sentAt: new Date(),
          updatedAt: new Date(),
          error: null,
        },
      }
    );

    console.log(`[AutoBooking] Successfully pushed booking ${bookingId} to ${adapter.provider}, appointment ID: ${result.appointment.id}`);

    return {
      success: true,
      bookingId,
      smsAppointmentId: result.appointment.id,
    };
  } catch (error) {
    console.error(`[AutoBooking] Error pushing booking ${bookingId}:`, error);
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    
    await db.collection("auto_booking_queue").updateOne(
      { _id: booking._id },
      {
        $set: {
          status: "failed",
          error: errorMsg,
          updatedAt: new Date(),
        },
      }
    );

    return { success: false, bookingId, error: errorMsg };
  }
}

export async function pushAllConfirmedBookings(shopId: number): Promise<{
  total: number;
  successful: number;
  failed: number;
  results: PushResult[];
}> {
  const db = await getDb();
  
  const confirmedBookings = await db
    .collection<BookingQueueItem>("auto_booking_queue")
    .find({ shopId, status: "confirmed" })
    .toArray();

  const results: PushResult[] = [];
  let successful = 0;
  let failed = 0;

  for (const booking of confirmedBookings) {
    const result = await pushConfirmedBooking(shopId, booking._id.toString());
    results.push(result);
    if (result.success) {
      successful++;
    } else {
      failed++;
    }
  }

  return {
    total: confirmedBookings.length,
    successful,
    failed,
    results,
  };
}

export async function getBookingQueueStats(shopId: number): Promise<{
  pending: number;
  confirmed: number;
  sent: number;
  failed: number;
  cancelled: number;
}> {
  const db = await getDb();
  
  const pipeline = [
    { $match: { shopId } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ];

  const results = await db.collection("auto_booking_queue").aggregate(pipeline).toArray();
  
  const stats = {
    pending: 0,
    confirmed: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const result of results) {
    const status = result._id as keyof typeof stats;
    if (status in stats) {
      stats[status] = result.count;
    }
  }

  return stats;
}

export async function retryFailedBooking(
  shopId: number,
  bookingId: string
): Promise<PushResult> {
  const db = await getDb();
  
  await db.collection("auto_booking_queue").updateOne(
    { _id: new ObjectId(bookingId), shopId, status: "failed" },
    {
      $set: {
        status: "confirmed",
        error: null,
        updatedAt: new Date(),
      },
    }
  );

  return pushConfirmedBooking(shopId, bookingId);
}
