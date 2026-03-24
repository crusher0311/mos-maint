import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import twilio from "twilio";
import { getTwilioConfig } from "@/lib/twilio";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const config = getTwilioConfig();
    if (!config.apiKey || !config.apiSecret || !config.accountSid) {
      return NextResponse.json(
        { error: "Twilio credentials not configured" },
        { status: 500 }
      );
    }

    const identity = session.email;

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: config.twimlAppSid || undefined,
      incomingAllow: true,
    });

    const token = new AccessToken(
      config.accountSid,
      config.apiKey,
      config.apiSecret,
      { identity, ttl: 3600 }
    );

    token.addGrant(voiceGrant);

    return NextResponse.json({
      token: token.toJwt(),
      identity,
    });
  } catch (error: any) {
    console.error("Voice token error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate voice token" },
      { status: 500 }
    );
  }
}
