import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { validateTwilioSignature, getTwilioConfig } from "@/lib/twilio";
import {
  createCommConversation,
  addCommMessage,
} from "@/lib/db/repositories/comm-conversations";
import { ensureCommunicationsTables } from "@/lib/db/init";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = String(value);
    });

    const signature = req.headers.get("x-twilio-signature") || "";
    const url = req.url;
    if (process.env.TWILIO_VALIDATE_SIGNATURE !== "false") {
      if (!validateTwilioSignature(url, params, signature)) {
        return new NextResponse("Forbidden", { status: 403 });
      }
    }

    const config = getTwilioConfig();
    const toNumber = params.To || params.number || "";
    const fromNumber = params.From || config.phoneNumber;
    const callSid = params.CallSid || "";

    if (!toNumber) {
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const twiml = new VoiceResponse();
      twiml.say("No destination number was provided.");
      twiml.hangup();
      return new NextResponse(twiml.toString(), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    await ensureCommunicationsTables();

    const shopId = parseInt(params.ShopId || process.env.DEFAULT_SHOP_ID || "1", 10);

    const conversation = await createCommConversation({
      shop_id: shopId,
      channel: "voice",
      direction: "outbound",
      customer_phone: toNumber,
      status: "active",
      subject: `Outbound call to ${toNumber}`,
    });

    await addCommMessage({
      conversation_id: conversation.id,
      channel: "voice",
      direction: "outbound",
      from_number: fromNumber,
      to_number: toNumber,
      call_sid: callSid,
      call_status: "initiated",
    });

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    const statusCallbackUrl = `${config.baseUrl}/api/webhooks/twilio/voice/status`;

    twiml.dial({
      callerId: config.phoneNumber || fromNumber,
      statusCallback: statusCallbackUrl,
      statusCallbackEvent: "initiated ringing answered completed",
    }).number(toNumber);

    return new NextResponse(twiml.toString(), {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error: any) {
    console.error("Outbound voice webhook error:", error);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    twiml.say("We're sorry, an error occurred placing your call. Please try again.");
    twiml.hangup();
    return new NextResponse(twiml.toString(), {
      headers: { "Content-Type": "text/xml" },
    });
  }
}
