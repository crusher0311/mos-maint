import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createExternalEndpoint(
  "appointments:create",
  async (req: NextRequest, { shopId }) => {
    const body = await req.json();
    
    const {
      customerId,
      customerName,
      customerPhone,
      customerEmail,
      vehicleId,
      vin,
      vehicleYear,
      vehicleMake,
      vehicleModel,
      serviceType,
      scheduledDate,
      scheduledTime,
      isDropOff = true,
      rideOption = "NONE",
      notes,
    } = body;
    
    if (!scheduledDate || !scheduledTime) {
      return NextResponse.json(
        { error: "scheduledDate and scheduledTime are required" },
        { status: 400 }
      );
    }
    
    if (!vin && !vehicleId) {
      return NextResponse.json(
        { error: "Either vin or vehicleId is required" },
        { status: 400 }
      );
    }
    
    const shopRows = await sql`
      SELECT id, settings FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
    `;
    const shop = shopRows[0];
    
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }
    
    const settings = shop.settings || {};
    const integrations = settings.integrations || [];
    const tekmetricConfig = settings.tekmetric || {};
    const protractorConfig = settings.protractor || {};
    const hasTekmetric = (integrations.includes("tekmetric") || tekmetricConfig?.shopId) && tekmetricConfig?.shopId;
    const hasProtractor = (integrations.includes("protractor") || protractorConfig?.connectionId || settings.protractorConnectionId);
    
    if (!hasTekmetric && !hasProtractor) {
      return NextResponse.json(
        { error: "No SMS integration configured for this shop" },
        { status: 400 }
      );
    }
    
    const shopTimezone = settings.timezone || "America/Chicago";
    const appointmentDuration = settings.autoBooking?.appointmentDuration || 60;
    
    const { getTimezoneOffset } = await import("@/lib/auto-booking/scheduler");
    const scheduledDateTime = new Date(`${scheduledDate}T${scheduledTime}:00`);
    const tzOffset = getTimezoneOffset(shopTimezone, scheduledDateTime);
    
    const startTimeStr = `${scheduledDate}T${scheduledTime}:00${tzOffset}`;
    const [hours, minutes] = scheduledTime.split(":").map(Number);
    const totalMinutes = hours * 60 + minutes + appointmentDuration;
    const endHours = Math.floor(totalMinutes / 60);
    const endMinutes = totalMinutes % 60;
    const endTimeStr = `${scheduledDate}T${String(endHours).padStart(2, "0")}:${String(endMinutes).padStart(2, "0")}:00${tzOffset}`;
    
    if (hasTekmetric) {
      try {
        const { createAppointment } = await import("@/lib/tekmetric");
        const { findTekmetricCustomerAndVehicle } = await import("@/lib/auto-booking/scheduler");
        
        const tekmetricShopId = Number(tekmetricConfig.shopId);
        
        const { customerId: tekmetricCustomerId, vehicleId: tekmetricVehicleId } = 
          await findTekmetricCustomerAndVehicle(
            tekmetricShopId,
            customerId,
            customerName,
            vehicleId,
            vin
          );
        
        if (!tekmetricCustomerId) {
          return NextResponse.json(
            { error: "Could not find customer in Tekmetric" },
            { status: 404 }
          );
        }
        
        if (!tekmetricVehicleId) {
          return NextResponse.json(
            { error: "Could not find vehicle in Tekmetric" },
            { status: 404 }
          );
        }
        
        const title = `[MOS API] ${serviceType || "Appointment"} - ${vehicleYear || ""} ${vehicleMake || ""} ${vehicleModel || ""}`.trim();
        
        const appointmentParams: any = {
          shopId: tekmetricShopId,
          customerId: tekmetricCustomerId,
          vehicleId: tekmetricVehicleId,
          startTime: startTimeStr,
          endTime: endTimeStr,
          title,
          description: notes || `Scheduled via MOS External API - ${serviceType || "Service"}`,
          color: "blue",
        };
        
        if (isDropOff) {
          appointmentParams.dropoffTime = startTimeStr;
          appointmentParams.pickupTime = endTimeStr;
          appointmentParams.rideOption = rideOption;
        }
        
        const appointment = await createAppointment(appointmentParams);
        
        await sql`
          INSERT INTO external_api_appointments (shop_id, external_id, provider, customer_id, customer_name, vehicle_id, vin, scheduled_date, scheduled_time, service_type, is_drop_off, ride_option, source, created_at)
          VALUES (${String(shopId)}, ${String(appointment.id)}, 'tekmetric', ${customerId || null}, ${customerName || null}, ${vehicleId || null}, ${vin || null}, ${scheduledDate}, ${scheduledTime}, ${serviceType || null}, ${isDropOff}, ${rideOption}, 'external_api', NOW())
        `;
        
        return NextResponse.json({
          success: true,
          appointmentId: String(appointment.id),
          provider: "tekmetric",
          scheduledDate,
          scheduledTime,
          startTime: startTimeStr,
          endTime: endTimeStr,
        });
        
      } catch (err: any) {
        console.error("[External API] Tekmetric appointment error:", err);
        return NextResponse.json(
          { error: "Failed to create Tekmetric appointment", message: err.message },
          { status: 500 }
        );
      }
    }
    
    if (hasProtractor) {
      try {
        const { createProtractorAppointment } = await import("@/lib/integrations/protractor");
        
        const appointmentNotes = isDropOff 
          ? `[Appointment Type] Drop-off Vehicle - ${serviceType || "Service"} - ${vehicleYear || ""} ${vehicleMake || ""} ${vehicleModel || ""}. ${notes || ""}`.trim()
          : `[Appointment Type] Stay With Vehicle - ${serviceType || "Service"} - ${vehicleYear || ""} ${vehicleMake || ""} ${vehicleModel || ""}. ${notes || ""}`.trim();
        
        const result = await createProtractorAppointment({
          shopId,
          contactId: customerId,
          vehicleId,
          scheduledTime: startTimeStr,
          duration: appointmentDuration,
          notes: appointmentNotes,
        });
        
        if (result.ok && result.appointmentId) {
          await sql`
            INSERT INTO external_api_appointments (shop_id, external_id, provider, customer_id, customer_name, vehicle_id, vin, scheduled_date, scheduled_time, service_type, is_drop_off, source, created_at)
            VALUES (${String(shopId)}, ${result.appointmentId}, 'protractor', ${customerId || null}, ${customerName || null}, ${vehicleId || null}, ${vin || null}, ${scheduledDate}, ${scheduledTime}, ${serviceType || null}, ${isDropOff}, 'external_api', NOW())
          `;
          
          return NextResponse.json({
            success: true,
            appointmentId: result.appointmentId,
            provider: "protractor",
            scheduledDate,
            scheduledTime,
          });
        } else {
          return NextResponse.json(
            { error: "Failed to create Protractor appointment", message: result.error },
            { status: 500 }
          );
        }
      } catch (err: any) {
        console.error("[External API] Protractor appointment error:", err);
        return NextResponse.json(
          { error: "Failed to create Protractor appointment", message: err.message },
          { status: 500 }
        );
      }
    }
    
    return NextResponse.json(
      { error: "No SMS integration available" },
      { status: 400 }
    );
  }
);

export const GET = createExternalEndpoint(
  "appointments:read",
  async (req: NextRequest, { shopId }) => {
    const limit = Number(req.nextUrl.searchParams.get("limit")) || 50;
    const skip = Number(req.nextUrl.searchParams.get("skip")) || 0;
    
    const appointments = await sql`
      SELECT * FROM external_api_appointments 
      WHERE shop_id = ${String(shopId)}
      ORDER BY created_at DESC
      OFFSET ${skip}
      LIMIT ${limit}
    `;
    
    return NextResponse.json({ appointments });
  }
);
