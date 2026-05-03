import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";

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
    
    const db = await getDb();
    
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { integrations: 1, tekmetric: 1, protractor: 1, protractorConnectionId: 1, timezone: 1, autoBooking: 1 } }
    );
    
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }
    
    const integrations = shop.integrations || [];
    const hasTekmetric = (integrations.includes("tekmetric") || shop.tekmetric?.shopId) && shop.tekmetric?.shopId;
    const hasProtractor = (integrations.includes("protractor") || shop.protractor?.connectionId || shop.protractorConnectionId);
    
    if (!hasTekmetric && !hasProtractor) {
      return NextResponse.json(
        { error: "No SMS integration configured for this shop" },
        { status: 400 }
      );
    }
    
    const shopTimezone = shop.timezone || "America/Chicago";
    const appointmentDuration = shop.autoBooking?.appointmentDuration || 60;
    
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
        const { createAppointment } = await import("@/lib/integrations/tekmetric");
        const { findTekmetricCustomerAndVehicle } = await import("@/lib/auto-booking/scheduler");
        
        const tekmetricShopId = Number(shop.tekmetric.shopId);
        
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
        
        await db.collection("external_api_appointments").insertOne({
          shopId,
          externalId: String(appointment.id),
          provider: "tekmetric",
          customerId,
          customerName,
          vehicleId,
          vin,
          scheduledDate,
          scheduledTime,
          serviceType,
          isDropOff,
          rideOption,
          createdAt: new Date(),
          source: "external_api",
        });
        
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
          await db.collection("external_api_appointments").insertOne({
            shopId,
            externalId: result.appointmentId,
            provider: "protractor",
            customerId,
            customerName,
            vehicleId,
            vin,
            scheduledDate,
            scheduledTime,
            serviceType,
            isDropOff,
            createdAt: new Date(),
            source: "external_api",
          });
          
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
    const db = await getDb();
    
    const limit = Number(req.nextUrl.searchParams.get("limit")) || 50;
    const skip = Number(req.nextUrl.searchParams.get("skip")) || 0;
    
    const appointments = await db.collection("external_api_appointments")
      .find({ shopId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    
    return NextResponse.json({ appointments });
  }
);
