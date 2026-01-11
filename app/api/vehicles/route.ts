import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);
    
    const body = await request.json();
    const { vin, year, make, model, customerFirstName, customerLastName, customerEmail, customerPhone, mileage, roNumber } = body;
    
    if (!vin || typeof vin !== "string") {
      return NextResponse.json({ error: "VIN is required" }, { status: 400 });
    }
    
    const normalizedVin = vin.toUpperCase().trim();
    
    if (normalizedVin.length < 11 || normalizedVin.length > 17) {
      return NextResponse.json({ error: "VIN must be 11-17 characters" }, { status: 400 });
    }
    
    let parsedYear: number | null = null;
    if (year !== null && year !== undefined && year !== "") {
      const yearNum = Number(year);
      if (isNaN(yearNum) || yearNum < 1900 || yearNum > new Date().getFullYear() + 2) {
        return NextResponse.json({ error: "Year must be a valid year (1900-current)" }, { status: 400 });
      }
      parsedYear = Math.floor(yearNum);
    }
    
    let parsedMileage: number | null = null;
    if (mileage !== null && mileage !== undefined && mileage !== "") {
      const mileageNum = Number(mileage);
      if (isNaN(mileageNum) || mileageNum < 0 || mileageNum > 2000000) {
        return NextResponse.json({ error: "Mileage must be a valid number (0-2,000,000)" }, { status: 400 });
      }
      parsedMileage = Math.floor(mileageNum);
    }
    
    const db = await getDb();
    
    const existing = await db.collection("vehicles").findOne({
      vin: normalizedVin,
      $or: [{ shopId }, { shopId: Number(shopId) }]
    });
    
    if (existing) {
      return NextResponse.json({ error: "Vehicle with this VIN already exists" }, { status: 409 });
    }
    
    const now = new Date();
    
    const vehicleDoc: Record<string, any> = {
      vin: normalizedVin,
      shopId,
      year: parsedYear,
      make: make?.trim() || null,
      model: model?.trim() || null,
      mileage: parsedMileage,
      lastMileage: parsedMileage,
      roNumber: roNumber?.trim() || null,
      source: "manual",
      createdAt: now,
      updatedAt: now,
    };
    
    if (customerFirstName || customerLastName || customerEmail || customerPhone) {
      vehicleDoc.customer = {
        firstName: customerFirstName?.trim() || null,
        lastName: customerLastName?.trim() || null,
        email: customerEmail?.trim() || null,
        phone: customerPhone?.trim() || null,
      };
    }
    
    const result = await db.collection("vehicles").insertOne(vehicleDoc);
    
    return NextResponse.json({
      ok: true,
      vehicleId: result.insertedId.toString(),
      vin: normalizedVin,
    });
  } catch (error: any) {
    console.error("Error creating vehicle:", error);
    return NextResponse.json({ error: error.message || "Failed to create vehicle" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);
    
    const { searchParams } = new URL(request.url);
    const vin = searchParams.get("vin");
    
    if (!vin) {
      return NextResponse.json({ error: "VIN parameter required" }, { status: 400 });
    }
    
    const db = await getDb();
    const vehicle = await db.collection("vehicles").findOne({
      vin: vin.toUpperCase(),
      $or: [{ shopId }, { shopId: Number(shopId) }]
    });
    
    if (!vehicle) {
      return NextResponse.json({ error: "Vehicle not found" }, { status: 404 });
    }
    
    return NextResponse.json({ vehicle });
  } catch (error: any) {
    console.error("Error fetching vehicle:", error);
    return NextResponse.json({ error: error.message || "Failed to fetch vehicle" }, { status: 500 });
  }
}
