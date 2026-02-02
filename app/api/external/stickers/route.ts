import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";

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
        currentMileage: currentMileage || 0,
        nextServiceMileage: nextServiceMileage || 0,
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
        currentMileage,
        nextServiceMileage,
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
