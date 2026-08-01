import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { normalizedWorkOrders } from "@/lib/db/schema/normalized";
import { and, desc, eq } from "drizzle-orm";

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

    // Recent orders from the normalized PG store (task #1000 — legacy
    // `repair_orders` reader retirement). The Mongo `customers.externalId`
    // is the source-system customer id, which is what
    // `normalized_work_orders.customer_id` stores; scope by the customer's
    // shopId since external ids can collide across shops. Returned fields /
    // ordering (orderNumber, status, createdAt, total; most-recent first)
    // match the previous Mongo projection.
    const customerExternalId =
      customer.externalId != null ? String(customer.externalId) : null;
    const customerShopId =
      customer.shopId != null ? Number(customer.shopId) : null;

    let recentOrders: Array<{
      id: string;
      orderNumber: string | null;
      status: string | null;
      createdAt: Date | null;
      total: string | null;
    }> = [];

    if (customerExternalId && customerShopId != null && Number.isFinite(customerShopId)) {
      const pg = getPgDb();
      recentOrders = await pg
        .select({
          id: normalizedWorkOrders.id,
          orderNumber: normalizedWorkOrders.workOrderNumber,
          status: normalizedWorkOrders.status,
          createdAt: normalizedWorkOrders.createdAt,
          total: normalizedWorkOrders.grandTotal,
        })
        .from(normalizedWorkOrders)
        .where(
          and(
            eq(normalizedWorkOrders.shopId, customerShopId),
            eq(normalizedWorkOrders.customerId, customerExternalId),
          ),
        )
        .orderBy(desc(normalizedWorkOrders.createdAt))
        .limit(5);
    }

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
      recentOrders: recentOrders.map((o) => ({
        id: String(o.id),
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
