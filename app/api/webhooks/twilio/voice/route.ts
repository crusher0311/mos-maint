import { NextRequest, NextResponse } from "next/server";
import { getRescueRoverSettings } from "@/lib/db/repositories/rescue-rover";
import twilio from "twilio";

function validateTwilioSignature(req: NextRequest, params: Record<string, string>): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return true;

  const signature = req.headers.get("x-twilio-signature") || "";
  const url =
    req.headers.get("x-forwarded-proto")
      ? `${req.headers.get("x-forwarded-proto")}://${req.headers.get("host")}${req.nextUrl.pathname}`
      : req.url;

  return twilio.validateRequest(authToken, signature, url, params);
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const from = formData.get("From")?.toString() || "";
    const to = formData.get("To")?.toString() || "";
    const callSid = formData.get("CallSid")?.toString() || "";
    const callStatus = formData.get("CallStatus")?.toString() || "";

    const formParams: Record<string, string> = {};
    formData.forEach((value, key) => {
      formParams[key] = value.toString();
    });

    if (!validateTwilioSignature(req, formParams)) {
      console.warn("[Twilio Voice] Invalid Twilio signature — rejecting request");
      return new NextResponse("Forbidden", { status: 403 });
    }

    console.log(
      `[Twilio Voice] Inbound call: from=${from} to=${to} sid=${callSid} status=${callStatus}`,
    );

    const shopId = await resolveShopId(to);

    if (!shopId) {
      console.warn(`[Twilio Voice] No shop found for number: ${to}`);
      return createTwimlResponse(
        `<Say>We're sorry, this number is not currently in service. Please try again later.</Say><Hangup/>`,
      );
    }

    const settings = await getRescueRoverSettings(shopId);

    if (!settings?.enabled) {
      console.log(
        `[Twilio Voice] Rescue Rover not enabled for shop ${shopId}, using default handler`,
      );
      return createTwimlResponse(
        `<Say>Thank you for calling. Please leave a message after the beep.</Say><Record maxLength="120" transcribe="true" /><Hangup/>`,
      );
    }

    const isAfterHours = checkAfterHours(
      settings.businessHours as any,
      settings.timezone || "America/New_York",
    );

    if (isAfterHours && settings.afterHoursGreeting) {
      return createTwimlResponse(
        `<Say>${escapeXml(settings.afterHoursGreeting)}</Say><Record maxLength="120" transcribe="true" /><Hangup/>`,
      );
    }

    const wsUrl = buildWebSocketUrl(req);
    const twiml = `<Connect><Stream url="${wsUrl}"><Parameter name="shopId" value="${shopId}" /><Parameter name="callerPhone" value="${escapeXml(from)}" /><Parameter name="callSid" value="${escapeXml(callSid)}" /></Stream></Connect>`;

    return createTwimlResponse(twiml);
  } catch (err) {
    console.error("[Twilio Voice] Error handling inbound call:", err);
    return createTwimlResponse(
      `<Say>We're experiencing technical difficulties. Please try again later.</Say><Hangup/>`,
    );
  }
}

async function resolveShopId(toNumber: string): Promise<number | null> {
  try {
    const { getDb } = await import("@/lib/db/drizzle");
    const { phoneNumbers } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = getDb();

    const digits = toNumber.replace(/\D/g, "");
    const variants = [toNumber, `+${digits}`, `+1${digits.replace(/^1/, "")}`];

    for (const variant of variants) {
      const result = await db.query.phoneNumbers.findFirst({
        where: eq(phoneNumbers.phoneNumber, variant),
      });
      if (result) return result.shopId;
    }
  } catch (err) {
    console.error("[Twilio Voice] Shop lookup error:", err);
  }

  const envShopId = process.env.DEFAULT_SHOP_ID;
  return envShopId ? parseInt(envShopId, 10) : null;
}

function checkAfterHours(
  businessHours: Record<string, { open: string; close: string } | null> | null,
  timezone: string,
): boolean {
  if (!businessHours) return false;

  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const weekday =
      parts.find((p) => p.type === "weekday")?.value?.toLowerCase() || "";
    const hour = parts.find((p) => p.type === "hour")?.value || "00";
    const minute = parts.find((p) => p.type === "minute")?.value || "00";
    const currentTime = `${hour}:${minute}`;

    const todayHours = businessHours[weekday];
    if (!todayHours) return true;

    return currentTime < todayHours.open || currentTime >= todayHours.close;
  } catch {
    return false;
  }
}

function buildWebSocketUrl(req: NextRequest): string {
  const wsHost = process.env.RESCUE_ROVER_WS_HOST;
  if (wsHost) {
    return `${wsHost}/ws/twilio-media`;
  }

  const host =
    req.headers.get("x-forwarded-host") ||
    req.headers.get("host") ||
    "localhost:3000";
  const wsPort = process.env.RESCUE_ROVER_WS_PORT || "3002";
  const hostWithoutPort = host.replace(/:\d+$/, "");
  const protocol = host.includes("localhost") ? "ws" : "wss";
  return `${protocol}://${hostWithoutPort}:${wsPort}/ws/twilio-media`;
}

function createTwimlResponse(body: string): NextResponse {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
  return new NextResponse(twiml, {
    headers: {
      "Content-Type": "text/xml",
    },
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
