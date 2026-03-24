import { NextRequest, NextResponse } from "next/server";
import {
  getRescueRoverSettings,
  upsertRescueRoverSettings,
} from "@/lib/db/repositories/rescue-rover";

export async function GET(req: NextRequest) {
  try {
    const shopId = req.nextUrl.searchParams.get("shopId");
    if (!shopId) {
      return NextResponse.json(
        { error: "shopId query parameter is required" },
        { status: 400 },
      );
    }

    const settings = await getRescueRoverSettings(parseInt(shopId, 10));
    if (!settings) {
      return NextResponse.json({
        settings: getDefaultSettings(parseInt(shopId, 10)),
        isDefault: true,
      });
    }

    return NextResponse.json({ settings, isDefault: false });
  } catch (err) {
    console.error("[RescueRover Settings] GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { shopId, ...data } = body;

    if (!shopId || typeof shopId !== "number") {
      return NextResponse.json(
        { error: "shopId is required and must be a number" },
        { status: 400 },
      );
    }

    const allowedFields = [
      "enabled",
      "voiceId",
      "voiceProvider",
      "greeting",
      "afterHoursGreeting",
      "maxCallDuration",
      "transferNumber",
      "enableTranscription",
      "enableSentimentAnalysis",
      "language",
      "timezone",
      "businessHours",
      "customInstructions",
      "metadata",
    ];

    const filtered: Record<string, unknown> = { shopId };
    for (const key of allowedFields) {
      if (data[key] !== undefined) {
        filtered[key] = data[key];
      }
    }

    const result = await upsertRescueRoverSettings(filtered as any);
    return NextResponse.json({ settings: result });
  } catch (err) {
    console.error("[RescueRover Settings] POST error:", err);
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 500 },
    );
  }
}

function getDefaultSettings(shopId: number) {
  return {
    shopId,
    enabled: false,
    voiceId: "aura-asteria-en",
    voiceProvider: "deepgram",
    greeting: "Hello! Thanks for calling. How can I help you today?",
    afterHoursGreeting:
      "Thanks for calling! We're currently closed. Please leave a message and we'll get back to you.",
    maxCallDuration: 300,
    transferNumber: null,
    enableTranscription: true,
    enableSentimentAnalysis: false,
    language: "en",
    timezone: "America/New_York",
    businessHours: {
      monday: { open: "08:00", close: "18:00" },
      tuesday: { open: "08:00", close: "18:00" },
      wednesday: { open: "08:00", close: "18:00" },
      thursday: { open: "08:00", close: "18:00" },
      friday: { open: "08:00", close: "18:00" },
      saturday: { open: "09:00", close: "14:00" },
      sunday: null,
    },
    customInstructions: null,
    metadata: null,
  };
}
