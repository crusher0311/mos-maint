import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, "");
}

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const phone = req.nextUrl.searchParams.get("phone");
    if (!phone) {
      return NextResponse.json({ error: "Missing phone parameter" }, { status: 400 });
    }

    const normalized = normalizePhone(phone);
    const digits = normalized.replace(/^\+1/, "").replace(/^\+/, "");

    const db = await getDb();

    const phonePatterns = [
      phone,
      normalized,
      `+1${digits}`,
      digits,
      digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : null,
      digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : null,
    ].filter(Boolean);

    const shopFilter = session.isPlatformAdmin ? {} : { shopId: session.shopId };

    const customer = await db.collection("customers").findOne({
      ...shopFilter,
      $or: [
        { phone: { $in: phonePatterns } },
        { "phone.mobile": { $in: phonePatterns } },
        { "phone.home": { $in: phonePatterns } },
        { "phone.work": { $in: phonePatterns } },
        { mobilePhone: { $in: phonePatterns } },
        { homePhone: { $in: phonePatterns } },
        { workPhone: { $in: phonePatterns } },
        { phones: { $elemMatch: { number: { $in: phonePatterns } } } },
      ],
    });

    if (!customer) {
      return NextResponse.json({ found: false, phone: normalized });
    }

    const vehicles = await db.collection("vehicles").find({
      $or: [
        { customerId: customer._id },
        { customer_id: customer._id },
        { "customer._id": customer._id },
      ],
    }).project({
      _id: 1,
      vin: 1,
      year: 1,
      make: 1,
      model: 1,
      mileage: 1,
      licensePlate: 1,
    }).limit(10).toArray();

    const recentOrders = await db.collection("repair_orders").find({
      $or: [
        { customerId: customer._id },
        { customer_id: customer._id },
      ],
    }).sort({ createdAt: -1 }).limit(5).project({
      _id: 1,
      orderNumber: 1,
      status: 1,
      createdAt: 1,
      total: 1,
      vehicleId: 1,
    }).toArray();

    const customerName = [
      customer.firstName || customer.first_name || "",
      customer.lastName || customer.last_name || "",
    ].filter(Boolean).join(" ") || customer.name || "Unknown";

    return NextResponse.json({
      found: true,
      customer: {
        id: String(customer._id),
        name: customerName,
        email: customer.email || null,
        phone: customer.phone || customer.mobilePhone || normalized,
        shopId: customer.shopId || null,
      },
      vehicles: vehicles.map((v: any) => ({
        id: String(v._id),
        vin: v.vin || null,
        year: v.year || null,
        make: v.make || null,
        model: v.model || null,
        mileage: v.mileage || null,
        licensePlate: v.licensePlate || null,
      })),
      recentOrders: recentOrders.map((o: any) => ({
        id: String(o._id),
        orderNumber: o.orderNumber || null,
        status: o.status || null,
        createdAt: o.createdAt || null,
        total: o.total || null,
      })),
    });
  } catch (error: any) {
    console.error("Caller lookup error:", error);
    return NextResponse.json(
      { error: error.message || "Caller lookup failed" },
      { status: 500 }
    );
  }
}
