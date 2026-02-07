import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export async function POST(request: NextRequest) {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const user = await db.collection("users").findOne(
      { _id: sess.userId },
      { projection: { email: 1, role: 1, shopId: 1 } }
    );
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const body = await request.json();
    const { customerName, roNumber, vin, mileage, vehicleYear, vehicleMake, vehicleModel } = body;

    if (!vin || vin.length !== 17) {
      return NextResponse.json({ error: "A valid 17-character VIN is required" }, { status: 400 });
    }
    if (!mileage || mileage <= 0) {
      return NextResponse.json({ error: "Mileage must be greater than 0" }, { status: 400 });
    }
    if (!customerName?.trim()) {
      return NextResponse.json({ error: "Customer name is required" }, { status: 400 });
    }

    const normalizedVin = vin.toUpperCase().trim();
    const shopId = Number(user.shopId);

    const existing = await db.collection("manual_vehicles").findOne({
      shopId,
      vin: normalizedVin,
      archived: { $ne: true },
    });

    if (existing) {
      await db.collection("manual_vehicles").updateOne(
        { _id: existing._id },
        {
          $set: {
            customerName: customerName.trim(),
            roNumber: roNumber?.trim() || null,
            mileage: Number(mileage),
            vehicleYear: vehicleYear ? Number(vehicleYear) : null,
            vehicleMake: vehicleMake?.trim() || null,
            vehicleModel: vehicleModel?.trim() || null,
            updatedAt: new Date(),
          },
        }
      );
    } else {
      const doc = {
        shopId,
        vin: normalizedVin,
        customerName: customerName.trim(),
        roNumber: roNumber?.trim() || null,
        mileage: Number(mileage),
        vehicleYear: vehicleYear ? Number(vehicleYear) : null,
        vehicleMake: vehicleMake?.trim() || null,
        vehicleModel: vehicleModel?.trim() || null,
        source: "manual",
        archived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: user.email,
      };
      await db.collection("manual_vehicles").insertOne(doc);
    }

    await db.collection("dashboard_updates").updateOne(
      { shopId },
      { $set: { lastUpdate: Date.now() } },
      { upsert: true }
    );

    const trimmedName = customerName.trim();
    const trimmedRo = roNumber?.trim() || null;
    const numMileage = Number(mileage);
    const numYear = vehicleYear ? Number(vehicleYear) : null;
    const trimmedMake = vehicleMake?.trim() || null;
    const trimmedModel = vehicleModel?.trim() || null;
    const displayVehicle = [numYear, trimmedMake, trimmedModel].filter(Boolean).join(" ");

    return NextResponse.json({
      success: true,
      row: {
        displayName: trimmedName,
        displayVehicle: displayVehicle || "Unknown Vehicle",
        displayVin: normalizedVin,
        displayRo: trimmedRo,
        displayMiles: numMileage,
        dviDone: false,
        source: "manual",
        updatedAt: new Date(),
        af: {
          status: "Manual",
          createdAt: new Date(),
          miles: numMileage,
        },
        vehicle: {
          year: numYear,
          make: trimmedMake,
          model: trimmedModel,
          engine: null,
        },
      },
    });
  } catch (error) {
    console.error("Manual vehicle creation error:", error);
    return NextResponse.json({ error: "Failed to add vehicle" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: new Date() } });
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const user = await db.collection("users").findOne(
      { _id: sess.userId },
      { projection: { shopId: 1 } }
    );
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const vin = searchParams.get("vin");
    if (!vin) {
      return NextResponse.json({ error: "VIN is required" }, { status: 400 });
    }

    const shopId = Number(user.shopId);
    await db.collection("manual_vehicles").updateOne(
      { shopId, vin: vin.toUpperCase() },
      { $set: { archived: true, updatedAt: new Date() } }
    );

    await db.collection("dashboard_updates").updateOne(
      { shopId },
      { $set: { lastUpdate: Date.now() } },
      { upsert: true }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Manual vehicle deletion error:", error);
    return NextResponse.json({ error: "Failed to remove vehicle" }, { status: 500 });
  }
}
