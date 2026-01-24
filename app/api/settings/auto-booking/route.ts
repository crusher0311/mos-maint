import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { 
  getUpcomingHolidays, 
  getHolidayDefinitionsWithStatus,
  DEFAULT_HOLIDAY_DEFINITIONS,
  PRESET_CUSTOM_HOLIDAYS,
  getPresetHolidayOptions,
  type CustomRecurringHoliday,
  type HolidayRule,
} from "@/lib/auto-booking/holidays";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidHolidayRule(rule: any): rule is HolidayRule {
  if (!rule || typeof rule !== "object" || !rule.type) return false;
  
  switch (rule.type) {
    case "fixed":
      return typeof rule.month === "number" && typeof rule.day === "number";
    case "nth_weekday":
      return typeof rule.month === "number" && typeof rule.weekday === "number" && typeof rule.n === "number";
    case "last_weekday":
      return typeof rule.month === "number" && typeof rule.weekday === "number";
    case "day_after":
      return typeof rule.baseHolidayId === "string" && typeof rule.daysAfter === "number";
    case "day_before":
      return typeof rule.baseHolidayId === "string" && typeof rule.daysBefore === "number";
    default:
      return false;
  }
}

export interface AutoBookingSettings {
  enabled: boolean;
  leadTimeDays: number;
  blockSaturday: boolean;
  blockSunday: boolean;
  blockHolidays: boolean;
  enabledHolidays: Record<string, boolean>;
  customHolidays: Array<{ date: string; name: string }>;
  customRecurringHolidays: CustomRecurringHoliday[];
  businessHours: {
    start: string;
    end: string;
  };
  latestBookingTime: string;
  maxBookingsPerDay: number;
  confirmationMode: "auto" | "review";
  preferredTimeSlot: "morning" | "afternoon" | "any";
  timezone: string;
  reminderTime: string;
  reminderDays: number[];
  skipReminderHolidays: boolean;
  queueExpiryDays: number;
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
  customRecurringHolidays: [],
  businessHours: {
    start: "08:00",
    end: "17:00",
  },
  latestBookingTime: "",
  maxBookingsPerDay: 10,
  confirmationMode: "review",
  preferredTimeSlot: "morning",
  timezone: "America/New_York",
  reminderTime: "08:00",
  reminderDays: [1, 2, 3, 4, 5],
  skipReminderHolidays: true,
  queueExpiryDays: 14,
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
      customRecurringHolidays: savedSettings.customRecurringHolidays || [],
    };

    const holidayDefinitions = getHolidayDefinitionsWithStatus(mergedSettings.enabledHolidays);
    const upcomingHolidays = getUpcomingHolidays(
      mergedSettings.enabledHolidays, 
      mergedSettings.customRecurringHolidays
    );
    const presetHolidayOptions = getPresetHolidayOptions();

    return NextResponse.json({
      available: true,
      settings: mergedSettings,
      holidayDefinitions,
      upcomingHolidays,
      presetHolidayOptions,
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
    if (Array.isArray(body.customRecurringHolidays)) {
      const validPresetIds = new Set(PRESET_CUSTOM_HOLIDAYS.map(p => p.id));
      settings.customRecurringHolidays = body.customRecurringHolidays
        .filter((h: any) => h.id && h.name && h.rule)
        .map((h: any) => {
          if (validPresetIds.has(h.id)) {
            const preset = PRESET_CUSTOM_HOLIDAYS.find(p => p.id === h.id);
            return { id: h.id, name: h.name || preset?.name, rule: preset?.rule };
          }
          if (h.rule && isValidHolidayRule(h.rule)) {
            return { id: h.id, name: h.name, rule: h.rule };
          }
          return null;
        })
        .filter(Boolean) as CustomRecurringHoliday[];
    }
    if (body.businessHours?.start && body.businessHours?.end) {
      settings.businessHours = {
        start: body.businessHours.start,
        end: body.businessHours.end,
      };
    }
    if (typeof body.latestBookingTime === "string") {
      if (body.latestBookingTime === "" || /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(body.latestBookingTime)) {
        settings.latestBookingTime = body.latestBookingTime;
      }
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
    if (typeof body.reminderTime === "string") {
      if (/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(body.reminderTime)) {
        settings.reminderTime = body.reminderTime;
      }
    }
    if (Array.isArray(body.reminderDays)) {
      settings.reminderDays = body.reminderDays.filter(
        (d: any) => typeof d === "number" && d >= 0 && d <= 6
      );
    }
    if (typeof body.skipReminderHolidays === "boolean") {
      settings.skipReminderHolidays = body.skipReminderHolidays;
    }
    if (typeof body.queueExpiryDays === "number" && body.queueExpiryDays >= 1 && body.queueExpiryDays <= 90) {
      settings.queueExpiryDays = body.queueExpiryDays;
    }

    const updateFields: Record<string, any> = {
      "autoBooking.updatedAt": new Date(),
    };
    
    for (const [key, value] of Object.entries(settings)) {
      if (key === "enabledHolidays" && typeof value === "object") {
        for (const [holidayId, enabled] of Object.entries(value as Record<string, boolean>)) {
          updateFields[`autoBooking.enabledHolidays.${holidayId}`] = enabled;
        }
      } else if (key === "businessHours" && typeof value === "object") {
        const bh = value as { start: string; end: string };
        updateFields["autoBooking.businessHours.start"] = bh.start;
        updateFields["autoBooking.businessHours.end"] = bh.end;
      } else {
        updateFields[`autoBooking.${key}`] = value;
      }
    }

    await db.collection("shops").updateOne(
      { shopId },
      { $set: updateFields }
    );

    return NextResponse.json({ ok: true, settings });
  } catch (err: any) {
    console.error("[Auto Booking Settings] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
