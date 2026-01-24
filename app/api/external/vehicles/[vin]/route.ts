import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { getDb } from "@/lib/mongo";

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
    
    const db = await getDb();
    
    const vehicle = await db.collection("vehicles").findOne({
      $or: [
        { vin: vin.toUpperCase() },
        { vin: vin.toLowerCase() },
        { vin }
      ]
    });
    
    if (!vehicle) {
      try {
        const { decodeVin } = await import("@/lib/dataone");
        const decoded = await decodeVin(vin);
        
        if (decoded) {
          return NextResponse.json({
            success: true,
            vin,
            source: "decoded",
            vehicle: {
              year: decoded.year,
              make: decoded.make,
              model: decoded.model,
              engine: decoded.engine,
              transmission: decoded.transmission,
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
