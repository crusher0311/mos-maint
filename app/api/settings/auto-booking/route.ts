import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { 
  getUpcomingHolidays, 
  getHolidayDefinitionsWithStatus,
  DEFAULT_HOLIDAY_DEFINITIONS 
} from "@/lib/auto-booking/holidays";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface AutoBookingSettings {
  enabled: boolean;
  leadTimeDays: number;
  blockSaturday: boolean;
  blockSunday: boolean;
  blockHolidays: boolean;
  enabledHolidays: Record<string, boolean>;
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

const DEFAULT_ENABLED_HOLIDAYS: Record<string, boolean> = Object.fromEntries(
  DEFAULT_HOLIDAY_DEFINITIONS.map(h => [h.id, true])
);

const DEFAULT_SETTINGS: AutoBookingSettings = {
  enabled: false,
  leadTimeDays: 3,
  blockSaturday: false,
  blockSunday: true,
  blockHolidays: true,
  enabledHolidays: DEFAULT_ENABLED_HOLIDAYS,
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
    const isPaid = shop?.billingStatus === "active" || 
                   shop?.plan === "professional" || 
                   shop?.plan === "enterprise" || 
                   shop?.plan === "demo" ||
                   hasOilSticker;
    
    console.log(`[Auto Booking] Shop ${shopId}: plan=${shop?.plan}, billingStatus=${shop?.billingStatus}, enabledFeatures=${JSON.stringify(rawFeatures)}, hasOilSticker=${hasOilSticker}, isPaid=${isPaid}`);
    
    if (!isPaid || !hasOilSticker) {
      return NextResponse.json({
        available: false,
        reason: !isPaid ? "Requires a paid plan" : "Requires Oil Sticker feature",
        settings: null,
      });
    }

    const savedSettings = shop?.autoBooking || {};
    const mergedSettings = {
      ...DEFAULT_SETTINGS,
      ...savedSettings,
      enabledHolidays: {
        ...DEFAULT_ENABLED_HOLIDAYS,
        ...(savedSettings.enabledHolidays || {}),
      },
    };

    const holidayDefinitions = getHolidayDefinitionsWithStatus(mergedSettings.enabledHolidays);
    const upcomingHolidays = getUpcomingHolidays(mergedSettings.enabledHolidays);

    return NextResponse.json({
      available: true,
      settings: mergedSettings,
      holidayDefinitions,
      upcomingHolidays,
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
    const isPaid = shop?.billingStatus === "active" || 
                   shop?.plan === "professional" || 
                   shop?.plan === "enterprise" || 
                   shop?.plan === "demo" ||
                   hasOilSticker;
    
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
    if (body.enabledHolidays && typeof body.enabledHolidays === "object") {
      const validHolidayIds = new Set(DEFAULT_HOLIDAY_DEFINITIONS.map(h => h.id));
      const filtered: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(body.enabledHolidays)) {
        if (validHolidayIds.has(key) && typeof value === "boolean") {
          filtered[key] = value as boolean;
        }
      }
      settings.enabledHolidays = filtered;
    }
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
