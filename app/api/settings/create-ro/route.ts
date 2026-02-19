import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FieldVisibility = "required" | "optional" | "hidden";

type CreateROSettings = {
  customerFields: Record<string, FieldVisibility>;
  vehicleFields: Record<string, FieldVisibility>;
  marketingSources: string[];
};

const DEFAULT_SETTINGS: CreateROSettings = {
  customerFields: {
    firstName: "required",
    lastName: "required",
    phone1: "required",
    phone2: "hidden",
    email: "optional",
    company: "optional",
    street: "optional",
    city: "optional",
    province: "optional",
    postalCode: "optional",
    country: "hidden",
    marketingSource: "optional",
    note: "hidden",
  },
  vehicleFields: {
    vin: "optional",
    year: "optional",
    make: "optional",
    model: "optional",
    submodel: "hidden",
    color: "optional",
    engine: "hidden",
    transmission: "hidden",
    odometer: "optional",
    licensePlate: "optional",
  },
  marketingSources: [],
};

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const shopId = Number(sess.shopId);
  const shop = await db.collection("shops").findOne({ shopId });

  const settings = shop?.createROSettings || DEFAULT_SETTINGS;

  return NextResponse.json({
    customerFields: { ...DEFAULT_SETTINGS.customerFields, ...settings.customerFields },
    vehicleFields: { ...DEFAULT_SETTINGS.vehicleFields, ...settings.vehicleFields },
    marketingSources: settings.marketingSources || [],
  });
}

export async function PUT(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "admin" && sess.role !== "owner") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await req.json();
  const { customerFields, vehicleFields, marketingSources } = body;

  const validVisibilities = ["required", "optional", "hidden"];

  if (customerFields) {
    for (const [key, val] of Object.entries(customerFields)) {
      if (!validVisibilities.includes(val as string)) {
        return NextResponse.json({ error: `Invalid visibility for ${key}: ${val}` }, { status: 400 });
      }
    }
    if (customerFields.firstName !== "required" || customerFields.lastName !== "required") {
      return NextResponse.json({ error: "First name and last name must always be required" }, { status: 400 });
    }
  }

  if (vehicleFields) {
    for (const [key, val] of Object.entries(vehicleFields)) {
      if (!validVisibilities.includes(val as string)) {
        return NextResponse.json({ error: `Invalid visibility for ${key}: ${val}` }, { status: 400 });
      }
    }
  }

  const db = await getDb();
  const shopId = Number(sess.shopId);

  const update: Record<string, any> = {};
  if (customerFields) update["createROSettings.customerFields"] = customerFields;
  if (vehicleFields) update["createROSettings.vehicleFields"] = vehicleFields;
  if (marketingSources !== undefined) update["createROSettings.marketingSources"] = marketingSources;

  await db.collection("shops").updateOne(
    { shopId },
    { $set: update }
  );

  return NextResponse.json({ success: true });
}
