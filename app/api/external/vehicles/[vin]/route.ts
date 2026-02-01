import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import sql from "@/lib/db/postgres";

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
    
    const vehicleRows = await sql`
      SELECT * FROM vehicles WHERE UPPER(vin) = ${vin.toUpperCase()} LIMIT 1
    `;
    const vehicle = vehicleRows[0];
    
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
        id: vehicle.id?.toString(),
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        engine: vehicle.engine,
        transmission: vehicle.transmission,
        customerId: vehicle.customer_id,
        lastServiceDate: vehicle.last_service_date,
        lastServiceMileage: vehicle.last_service_mileage,
        nextServiceDate: vehicle.next_service_date,
        nextServiceMileage: vehicle.next_service_mileage,
      }
    });
  }
);
