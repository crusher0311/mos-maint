import { NextResponse, NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import sql from "@/lib/db/postgres";

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
  maxBookingsPerSlot: number;
  appointmentDuration: 30 | 60;
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
  maxBookingsPerSlot: 2,
  appointmentDuration: 60,
  confirmationMode: "review",
  preferredTimeSlot: "morning",
  timezone: "America/New_York",
};

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = String(session.shopId);
    const numericShopId = Number(session.shopId);
    
    const entitlements = await getFeatureEntitlements(numericShopId);
    if (!entitlements.canUseFeature("auto_booking")) {
      return NextResponse.json({
        available: false,
        reason: "Auto Booking feature is not enabled for this shop",
        settings: null,
      });
    }
    
    const shopResult = await sql`
      SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1
    `;
    const shopSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
    const autoBooking = (shopSettings.autoBooking as AutoBookingSettings) || DEFAULT_SETTINGS;

    return NextResponse.json({
      available: true,
      settings: {
        ...DEFAULT_SETTINGS,
        ...autoBooking,
      },
      defaultHolidays: DEFAULT_HOLIDAYS,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Auto Booking Settings] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = String(session.shopId);
    const numericShopId = Number(session.shopId);
    
    const entitlements = await getFeatureEntitlements(numericShopId);
    if (!entitlements.canUseFeature("auto_booking")) {
      return NextResponse.json(
        { error: "Auto Booking feature is not enabled for this shop" },
        { status: 403 }
      );
    }

    const body = await req.json();
    const settings: Partial<AutoBookingSettings> & { updatedAt?: string } = {};

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
        (h: { date?: string; name?: string }) => h.date && h.name && typeof h.date === "string" && typeof h.name === "string"
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
    if (typeof body.maxBookingsPerSlot === "number" && body.maxBookingsPerSlot >= 1 && body.maxBookingsPerSlot <= 20) {
      settings.maxBookingsPerSlot = body.maxBookingsPerSlot;
    }
    if (body.appointmentDuration === 30 || body.appointmentDuration === 60) {
      settings.appointmentDuration = body.appointmentDuration;
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

    settings.updatedAt = new Date().toISOString();

    const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
    
    const updatedSettings = {
      ...existingSettings,
      autoBooking: settings
    };

    await sql`
      UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${new Date()}
      WHERE shop_id = ${shopId}
    `;

    return NextResponse.json({ ok: true, settings });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Auto Booking Settings] Error:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
