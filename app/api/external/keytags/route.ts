import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";

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

    // Coerce caller-supplied mileage values (strings like "71,378" are
    // accepted) and reject implausible values.
    const { parseMileageInput, isAbsurdMileage, MAX_PLAUSIBLE_MILEAGE } = await import("@/lib/sticker-mileage");
    let parsedCurrentMileage: number | undefined;
    let parsedNextServiceMileage: number | undefined;
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
        { projection: { name: 1, keytagDesign: 1 } }
      );
      
      if (!shop) {
        return NextResponse.json({ error: "Shop not found" }, { status: 404 });
      }
      
      const keytagData = {
        shopId,
        vin,
        customerId,
        customerName,
        customerPhone,
        vehicleYear,
        vehicleMake,
        vehicleModel,
        vehicleInfo: `${vehicleYear || ""} ${vehicleMake || ""} ${vehicleModel || ""}`.trim(),
        currentMileage: parsedCurrentMileage,
        nextServiceMileage: parsedNextServiceMileage,
        nextServiceDate,
        oilType,
        tagNumber,
        roNumber,
        createdAt: new Date(),
        source: "external_api",
      };
      
      await db.collection("external_api_keytags").insertOne(keytagData);
      
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
