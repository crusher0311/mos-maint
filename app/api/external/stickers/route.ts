import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createExternalEndpoint(
  "stickers:generate",
  async (req: NextRequest, { shopId }) => {
    const body = await req.json();
    
    // Task #439: `oilType` is a free-form string from the caller (typically
    // one of conventional/synthetic/euro/diesel, but not enforced). The
    // per-shop "Hide from pickers" flag added in task #439 is UI-only: it
    // only suppresses buckets from the dashboard + extension dropdowns and
    // intentionally does NOT validate/reject external callers passing a
    // hidden oilType here. External integrations are expected to know what
    // they want regardless of which buckets the shop chose to surface in
    // its own UI.
    const {
      vin,
      vehicleYear,
      vehicleMake,
      vehicleModel,
      customerId,
      customerName,
      customerPhone,
      customerEmail,
      vehicleId,
      currentMileage,
      nextServiceMileage,
      nextServiceDate,
      oilType,
      oilBrand,
      triggerAutoBooking = false,
    } = body;
    
    if (!vin) {
      return NextResponse.json(
        { error: "vin is required" },
        { status: 400 }
      );
    }

    // Coerce caller-supplied mileage values (strings like "71,378" are
    // accepted) and reject implausible values so a bad payload never
    // records/prints an absurd sticker.
    const { parseMileageInput, isAbsurdMileage, MAX_PLAUSIBLE_MILEAGE } = await import("@/lib/sticker-mileage");
    let parsedCurrentMileage = 0;
    let parsedNextServiceMileage = 0;
    if (currentMileage !== undefined && currentMileage !== null && currentMileage !== "") {
      const parsed = parseMileageInput(currentMileage);
      if (parsed === null || isAbsurdMileage(parsed)) {
        return NextResponse.json(
          { error: `currentMileage must be a positive number no greater than ${MAX_PLAUSIBLE_MILEAGE}` },
          { status: 400 }
        );
      }
      parsedCurrentMileage = parsed;
    }
    if (nextServiceMileage !== undefined && nextServiceMileage !== null && nextServiceMileage !== "") {
      const parsed = parseMileageInput(nextServiceMileage);
      if (parsed === null || isAbsurdMileage(parsed)) {
        return NextResponse.json(
          { error: `nextServiceMileage must be a positive number no greater than ${MAX_PLAUSIBLE_MILEAGE}` },
          { status: 400 }
        );
      }
      parsedNextServiceMileage = parsed;
    }
    
    try {
      const { getDb } = await import("@/lib/mongo");
      const db = await getDb();
      
      const shop = await db.collection("shops").findOne(
        { shopId },
        { projection: { name: 1, sticker: 1, qrCode: 1, autoBooking: 1 } }
      );
      
      if (!shop) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 });
      }
      
      const internalRequest = {
        vin,
        vehicleYear,
        vehicleMake,
        vehicleModel,
        customerId,
        customerName,
        customerPhone,
        customerEmail,
        vehicleId,
        currentMileage: parsedCurrentMileage,
        nextServiceMileage: parsedNextServiceMileage,
        nextServiceDate: nextServiceDate || "",
        oilType: oilType || "",
        oilBrand: oilBrand || "",
        skipAutoBooking: !triggerAutoBooking,
        externalApiCall: true,
      };
      
      await db.collection("external_api_stickers").insertOne({
        shopId,
        vin,
        customerId,
        customerName,
        vehicleYear,
        vehicleMake,
        vehicleModel,
        currentMileage: parsedCurrentMileage,
        nextServiceMileage: parsedNextServiceMileage,
        nextServiceDate,
        oilType,
        oilBrand,
        triggerAutoBooking,
        createdAt: new Date(),
        source: "external_api",
      });
      
      return NextResponse.json({
        success: true,
        message: "Sticker generation request received. Use the internal sticker/generate API with a valid session for full image generation.",
        data: internalRequest,
        note: "Full sticker image generation requires session authentication. This endpoint logs the request for tracking.",
      });
      
    } catch (err: any) {
      console.error("[External API] Sticker error:", err);
      return NextResponse.json(
        { error: "Failed to process sticker request", message: err.message },
        { status: 500 }
      );
    }
  }
);
