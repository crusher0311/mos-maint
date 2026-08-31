import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";
import { getFeatureEntitlements } from "@/lib/featureResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createExternalEndpoint(
  "vehicles:read",
  async (req: NextRequest, { shopId }) => {
    const vin = req.nextUrl.pathname.split("/").pop();
    
    if (!vin || vin.length < 11) {
      return NextResponse.json(
        { error: "Valid VIN is required" },
        { status: 400 }
      );
    }
    const entitlements = await getFeatureEntitlements(Number(shopId));
    if (!entitlements.canUseFeature("maintenance")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
    }
    
    const db = await getDb();
    
    const vehicle = await db.collection("vehicles").findOne({
      shopId: { $in: [Number(shopId), String(shopId)] },
      vin: { $in: [vin.toUpperCase(), vin.toLowerCase(), vin] },
    });
    
    if (!vehicle) {
      try {
        const { decodeVin } = await import("@/lib/integrations/dataone-api");
        const result = await decodeVin(vin);
        
        if (result.ok && result.decoded) {
          const decoded = result.decoded;
          return NextResponse.json({
            success: true,
            vin,
            source: "decoded",
            vehicle: {
              year: decoded.year,
              make: decoded.make,
              model: decoded.model,
              engine: decoded.engine_name,
              transmission: decoded.trans_name,
            }
          });
        }
      } catch (decodeErr: any) {
        console.error("[External API] VIN decode error:", decodeErr);
      }
      
      return NextResponse.json(
        { error: "Vehicle not found", vin },
        { status: 404 }
      );
    }
    
    return NextResponse.json({
      success: true,
      vin,
      source: "database",
      vehicle: {
        id: vehicle._id?.toString(),
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        engine: vehicle.engine,
        transmission: vehicle.transmission,
        customerId: vehicle.customerId,
        lastServiceDate: vehicle.lastServiceDate,
        lastServiceMileage: vehicle.lastServiceMileage,
        nextServiceDate: vehicle.nextServiceDate,
        nextServiceMileage: vehicle.nextServiceMileage,
      }
    });
  }
);
