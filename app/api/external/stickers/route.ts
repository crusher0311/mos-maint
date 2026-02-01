import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createExternalEndpoint(
  "stickers:generate",
  async (req: NextRequest, { shopId }) => {
    const body = await req.json();
    
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
    
    try {
      const shopRows = await sql`
        SELECT name, settings FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
      `;
      const shop = shopRows[0];
      
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
        currentMileage: currentMileage || 0,
        nextServiceMileage: nextServiceMileage || 0,
        nextServiceDate: nextServiceDate || "",
        oilType: oilType || "",
        oilBrand: oilBrand || "",
        skipAutoBooking: !triggerAutoBooking,
        externalApiCall: true,
      };
      
      await sql`
        INSERT INTO external_api_stickers (shop_id, vin, customer_id, customer_name, vehicle_year, vehicle_make, vehicle_model, current_mileage, next_service_mileage, next_service_date, oil_type, oil_brand, trigger_auto_booking, source, created_at)
        VALUES (${String(shopId)}, ${vin}, ${customerId || null}, ${customerName || null}, ${vehicleYear || null}, ${vehicleMake || null}, ${vehicleModel || null}, ${currentMileage || null}, ${nextServiceMileage || null}, ${nextServiceDate || null}, ${oilType || null}, ${oilBrand || null}, ${triggerAutoBooking}, 'external_api', NOW())
      `;
      
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
