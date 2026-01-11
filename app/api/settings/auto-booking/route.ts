import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const US_HOLIDAYS_2025 = [
  { date: "2025-01-01", name: "New Year's Day" },
  { date: "2025-01-20", name: "Martin Luther King Jr. Day" },
  { date: "2025-02-17", name: "Presidents' Day" },
  { date: "2025-05-26", name: "Memorial Day" },
  { date: "2025-07-04", name: "Independence Day" },
  { date: "2025-09-01", name: "Labor Day" },
  { date: "2025-10-13", name: "Columbus Day" },
  { date: "2025-11-11", name: "Veterans Day" },
  { date: "2025-11-27", name: "Thanksgiving Day" },
  { date: "2025-12-25", name: "Christmas Day" },
];

const US_HOLIDAYS_2026 = [
  { date: "2026-01-01", name: "New Year's Day" },
  { date: "2026-01-19", name: "Martin Luther King Jr. Day" },
  { date: "2026-02-16", name: "Presidents' Day" },
  { date: "2026-05-25", name: "Memorial Day" },
  { date: "2026-07-03", name: "Independence Day (Observed)" },
  { date: "2026-07-04", name: "Independence Day" },
  { date: "2026-09-07", name: "Labor Day" },
  { date: "2026-10-12", name: "Columbus Day" },
  { date: "2026-11-11", name: "Veterans Day" },
  { date: "2026-11-26", name: "Thanksgiving Day" },
  { date: "2026-12-25", name: "Christmas Day" },
];

const DEFAULT_HOLIDAYS = [...US_HOLIDAYS_2025, ...US_HOLIDAYS_2026];

export interface AutoBookingSettings {
  enabled: boolean;
  leadTimeDays: number;
  blockSaturday: boolean;
  blockSunday: boolean;
  blockHolidays: boolean;
  useDefaultHolidays: boolean;
  customHolidays: Array<{ date: string; name: string }>;
  businessHours: {
    start: string;
    end: string;
  };
  maxBookingsPerDay: number;
  confirmationMode: "auto" | "review";
  preferredTimeSlot: "morning" | "afternoon" | "any";
  timezone: string;
}

const DEFAULT_SETTINGS: AutoBookingSettings = {
  enabled: false,
  leadTimeDays: 3,
  blockSaturday: false,
  blockSunday: true,
  blockHolidays: true,
  useDefaultHolidays: true,
  customHolidays: [],
  businessHours: {
    start: "08:00",
    end: "17:00",
  },
  maxBookingsPerDay: 10,
  confirmationMode: "review",
  preferredTimeSlot: "morning",
  timezone: "America/New_York",
};

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const db = await getDb();
    
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { autoBooking: 1, enabledFeatures: 1, plan: 1, billingStatus: 1 } }
    );

    const rawFeatures = shop?.enabledFeatures;
    const hasOilSticker = Array.isArray(rawFeatures) 
      ? rawFeatures.includes("oil_sticker")
      : (rawFeatures && typeof rawFeatures === "object" && rawFeatures.oil_sticker === true);
    const isPaid = shop?.billingStatus === "active" || shop?.plan === "professional" || shop?.plan === "enterprise";
    
    if (!isPaid || !hasOilSticker) {
      return NextResponse.json({
        available: false,
        reason: !isPaid ? "Requires a paid plan" : "Requires Oil Sticker feature",
        settings: null,
      });
    }

    const settings = shop?.autoBooking || DEFAULT_SETTINGS;

    return NextResponse.json({
      available: true,
      settings: {
        ...DEFAULT_SETTINGS,
        ...settings,
      },
      defaultHolidays: DEFAULT_HOLIDAYS,
    });
  } catch (err: any) {
    console.error("[Auto Booking Settings] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = Number(session.shopId);
    const db = await getDb();
    
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { enabledFeatures: 1, plan: 1, billingStatus: 1 } }
    );

    const rawFeatures = shop?.enabledFeatures;
    const hasOilSticker = Array.isArray(rawFeatures) 
      ? rawFeatures.includes("oil_sticker")
      : (rawFeatures && typeof rawFeatures === "object" && rawFeatures.oil_sticker === true);
    const isPaid = shop?.billingStatus === "active" || shop?.plan === "professional" || shop?.plan === "enterprise";
    
    if (!isPaid || !hasOilSticker) {
      return NextResponse.json(
        { error: "Auto Booking requires a paid plan with Oil Sticker enabled" },
        { status: 403 }
      );
    }

    const body = await req.json();
    const settings: Partial<AutoBookingSettings> = {};

    if (typeof body.enabled === "boolean") settings.enabled = body.enabled;
    if (typeof body.leadTimeDays === "number" && body.leadTimeDays >= 0 && body.leadTimeDays <= 30) {
      settings.leadTimeDays = body.leadTimeDays;
    }
    if (typeof body.blockSaturday === "boolean") settings.blockSaturday = body.blockSaturday;
    if (typeof body.blockSunday === "boolean") settings.blockSunday = body.blockSunday;
    if (typeof body.blockHolidays === "boolean") settings.blockHolidays = body.blockHolidays;
    if (typeof body.useDefaultHolidays === "boolean") settings.useDefaultHolidays = body.useDefaultHolidays;
    if (Array.isArray(body.customHolidays)) {
      settings.customHolidays = body.customHolidays.filter(
        (h: any) => h.date && h.name && typeof h.date === "string" && typeof h.name === "string"
      );
    }
    if (body.businessHours?.start && body.businessHours?.end) {
      settings.businessHours = {
        start: body.businessHours.start,
        end: body.businessHours.end,
      };
    }
    if (typeof body.maxBookingsPerDay === "number" && body.maxBookingsPerDay >= 1 && body.maxBookingsPerDay <= 100) {
      settings.maxBookingsPerDay = body.maxBookingsPerDay;
    }
    if (body.confirmationMode === "auto" || body.confirmationMode === "review") {
      settings.confirmationMode = body.confirmationMode;
    }
    if (body.preferredTimeSlot === "morning" || body.preferredTimeSlot === "afternoon" || body.preferredTimeSlot === "any") {
      settings.preferredTimeSlot = body.preferredTimeSlot;
    }
    if (typeof body.timezone === "string") {
      settings.timezone = body.timezone;
    }

    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          autoBooking: settings,
          "autoBooking.updatedAt": new Date(),
        },
      }
    );

    return NextResponse.json({ ok: true, settings });
  } catch (err: any) {
    console.error("[Auto Booking Settings] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
