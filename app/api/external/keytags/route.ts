import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createExternalEndpoint(
  "keytags:generate",
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
      currentMileage,
      nextServiceMileage,
      nextServiceDate,
      oilType,
      tagNumber,
      roNumber,
    } = body;
    
    if (!vin && !customerName) {
      return NextResponse.json(
        { error: "vin or customerName is required" },
        { status: 400 }
      );
    }
    
    try {
      const shopRows = await sql`
        SELECT name, settings->'keytagDesign' as keytag_design 
        FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1
      `;
      const shop = shopRows[0];
      
      if (!shop) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 });
      }
      
      const keytagData = {
        shopId: String(shopId),
        vin,
        customerId,
        customerName,
        customerPhone,
        vehicleYear,
        vehicleMake,
        vehicleModel,
        vehicleInfo: `${vehicleYear || ""} ${vehicleMake || ""} ${vehicleModel || ""}`.trim(),
        currentMileage,
        nextServiceMileage,
        nextServiceDate,
        oilType,
        tagNumber,
        roNumber,
        createdAt: new Date(),
        source: "external_api",
      };
      
      await sql`
        INSERT INTO external_api_keytags (shop_id, vin, customer_id, customer_name, customer_phone, vehicle_year, vehicle_make, vehicle_model, vehicle_info, current_mileage, next_service_mileage, next_service_date, oil_type, tag_number, ro_number, source, created_at)
        VALUES (${keytagData.shopId}, ${keytagData.vin || null}, ${keytagData.customerId || null}, ${keytagData.customerName || null}, ${keytagData.customerPhone || null}, ${keytagData.vehicleYear || null}, ${keytagData.vehicleMake || null}, ${keytagData.vehicleModel || null}, ${keytagData.vehicleInfo || null}, ${keytagData.currentMileage || null}, ${keytagData.nextServiceMileage || null}, ${keytagData.nextServiceDate || null}, ${keytagData.oilType || null}, ${keytagData.tagNumber || null}, ${keytagData.roNumber || null}, ${keytagData.source}, ${keytagData.createdAt})
      `;
      
      return NextResponse.json({
        success: true,
        message: "Keytag generation request received. Use the internal keytag/generate API with a valid session for full image generation.",
        data: keytagData,
        note: "Full keytag image generation requires session authentication. This endpoint logs the request for tracking.",
      });
      
    } catch (err: any) {
      console.error("[External API] Keytag error:", err);
      return NextResponse.json(
        { error: "Failed to process keytag request", message: err.message },
        { status: 500 }
      );
    }
  }
);
