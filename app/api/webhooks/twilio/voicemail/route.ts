import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { validateTwilioSignature, getTwilioConfig } from "@/lib/twilio";
import { createCommVoicemail } from "@/lib/db/repositories/comm-voicemails";
import { updateCommConversation, addCommMessage } from "@/lib/db/repositories/comm-conversations";
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
    const callerPhone = params.From || params.Caller || "";
    const dialCallStatus = params.DialCallStatus || "";
    const recordingUrl = params.RecordingUrl || "";
    const recordingSid = params.RecordingSid || "";
    const recordingDuration = parseInt(params.RecordingDuration || "0", 10);

    const shopId = parseInt(
      req.nextUrl.searchParams.get("shopId") || process.env.DEFAULT_SHOP_ID || "1",
      10
    );
    const conversationId = req.nextUrl.searchParams.get("conversationId") || null;

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();

    if (recordingUrl && recordingSid) {
      await ensureCommunicationsTables();

      await createCommVoicemail({
        shop_id: shopId,
        conversation_id: conversationId,
        caller_phone: callerPhone,
        recording_url: recordingUrl,
        recording_sid: recordingSid,
        duration: recordingDuration,
      });

      if (conversationId) {
        await addCommMessage({
          conversation_id: conversationId,
          channel: "voice",
          direction: "inbound",
          from_number: callerPhone,
          to_number: config.phoneNumber,
          body: "Voicemail recording",
          call_status: "voicemail",
          call_duration: recordingDuration,
          recording_url: recordingUrl,
          metadata: { recordingSid, type: "voicemail" },
        });
        await updateCommConversation(conversationId, { status: "voicemail" });
      }

      twiml.say({ voice: "Polly.Matthew" }, "Thank you for your message. Goodbye.");
      twiml.hangup();
    } else if (["no-answer", "busy", "failed", "canceled"].includes(dialCallStatus)) {
      if (conversationId) {
        await ensureCommunicationsTables();
        await updateCommConversation(conversationId, { status: "missed" });
      }

      twiml.say(
        { voice: "Polly.Matthew" },
        "We're sorry, no one is available to take your call. Please leave a message after the beep."
      );

      twiml.record({
        maxLength: 120,
        action: `${config.baseUrl}/api/webhooks/twilio/voicemail?shopId=${shopId}${conversationId ? `&conversationId=${conversationId}` : ""}`,
        transcribe: false,
        playBeep: true,
      });

      twiml.say({ voice: "Polly.Matthew" }, "We did not receive a recording. Goodbye.");
      twiml.hangup();
    } else {
      twiml.hangup();
    }

    return new NextResponse(twiml.toString(), {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error: any) {
    console.error("Voicemail webhook error:", error);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    twiml.say("An error occurred. Goodbye.");
    twiml.hangup();
    return new NextResponse(twiml.toString(), {
      headers: { "Content-Type": "text/xml" },
    });
  }
}
