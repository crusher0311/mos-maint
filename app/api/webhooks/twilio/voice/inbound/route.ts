import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { validateTwilioSignature, getTwilioConfig } from "@/lib/twilio";
import {
  createCommConversation,
  findCommConversationByPhone,
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
    const callerNumber = params.From || "";
    const calledNumber = params.To || "";
    const callSid = params.CallSid || "";

    await ensureCommunicationsTables();

    const shopId = parseInt(params.ShopId || process.env.DEFAULT_SHOP_ID || "1", 10);

    let conversation = await findCommConversationByPhone(shopId, callerNumber, "voice");
    if (!conversation) {
      conversation = await createCommConversation({
        shop_id: shopId,
        channel: "voice",
        direction: "inbound",
        customer_phone: callerNumber,
        status: "active",
        subject: `Inbound call from ${callerNumber}`,
      });
    }

    await addCommMessage({
      conversation_id: conversation.id,
      channel: "voice",
      direction: "inbound",
      from_number: callerNumber,
      to_number: calledNumber,
      call_sid: callSid,
      call_status: "ringing",
    });

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    const rescueRoverEnabled = process.env.RESCUE_ROVER_ENABLED === "true";

    if (rescueRoverEnabled) {
      twiml.say(
        { voice: "Polly.Matthew" },
        "Thank you for calling. Please hold while we connect you."
      );

      const statusCallbackUrl = `${config.baseUrl}/api/webhooks/twilio/voice/status`;

      twiml.dial({
        callerId: calledNumber,
        action: `${config.baseUrl}/api/webhooks/twilio/voicemail?shopId=${shopId}&conversationId=${conversation.id}`,
        timeout: 20,
      }).client(
        { statusCallback: statusCallbackUrl, statusCallbackEvent: "initiated ringing answered completed" },
        process.env.RESCUE_ROVER_CLIENT_IDENTITY || "rescue-rover"
      );
    } else {
      twiml.say(
        { voice: "Polly.Matthew" },
        "Thank you for calling. We are connecting your call now."
      );

      const forwardTo = process.env.CALL_FORWARD_NUMBER;
      if (forwardTo) {
        twiml.dial({
          callerId: callerNumber,
          action: `${config.baseUrl}/api/webhooks/twilio/voicemail?shopId=${shopId}&conversationId=${conversation.id}`,
          timeout: 25,
        }).number(forwardTo);
      } else {
        twiml.dial({
          callerId: calledNumber,
          action: `${config.baseUrl}/api/webhooks/twilio/voicemail?shopId=${shopId}&conversationId=${conversation.id}`,
          timeout: 25,
        }).client("dashboard-user");
      }
    }

    return new NextResponse(twiml.toString(), {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error: any) {
    console.error("Inbound voice webhook error:", error);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    twiml.say("We're sorry, an error occurred. Please try again later.");
    twiml.hangup();
    return new NextResponse(twiml.toString(), {
      headers: { "Content-Type": "text/xml" },
    });
  }
}
