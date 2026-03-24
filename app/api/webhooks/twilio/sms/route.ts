import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";
import { validateTwilioSignature } from "@/lib/twilio";
import {
  findCommConversationByPhone,
  createCommConversation,
  addCommMessage,
  updateCommConversation,
} from "@/lib/db/repositories/comm-conversations";
import { ensureCommunicationsTables } from "@/lib/db/init";

export const runtime = "nodejs";

const OPT_OUT_KEYWORDS = ["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
const OPT_IN_KEYWORDS = ["START", "YES", "UNSTOP"];

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

    const from = params.From || "";
    const to = params.To || "";
    const body = params.Body || "";
    const messageSid = params.MessageSid || "";
    const numMedia = parseInt(params.NumMedia || "0", 10);

    const mediaUrls: string[] = [];
    for (let i = 0; i < numMedia; i++) {
      const mediaUrl = params[`MediaUrl${i}`];
      if (mediaUrl) mediaUrls.push(mediaUrl);
    }

    const upperBody = body.trim().toUpperCase();
    const MessagingResponse = twilio.twiml.MessagingResponse;
    const twiml = new MessagingResponse();

    if (OPT_OUT_KEYWORDS.includes(upperBody)) {
      twiml.message("You have been unsubscribed. Reply START to opt back in.");
      return new NextResponse(twiml.toString(), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    if (OPT_IN_KEYWORDS.includes(upperBody)) {
      twiml.message("You have been re-subscribed to messages. Reply STOP to opt out.");
      return new NextResponse(twiml.toString(), {
        headers: { "Content-Type": "text/xml" },
      });
    }

    await ensureCommunicationsTables();

    const shopId = parseInt(process.env.DEFAULT_SHOP_ID || "1", 10);

    let conversation = await findCommConversationByPhone(shopId, from, "sms");
    if (!conversation) {
      conversation = await createCommConversation({
        shop_id: shopId,
        channel: "sms",
        direction: "inbound",
        customer_phone: from,
        status: "active",
        subject: `SMS from ${from}`,
      });
    } else if (conversation.status === "closed") {
      await updateCommConversation(conversation.id, { status: "active" });
    }

    await addCommMessage({
      conversation_id: conversation.id,
      channel: "sms",
      direction: "inbound",
      from_number: from,
      to_number: to,
      body,
      media_urls: mediaUrls.length > 0 ? mediaUrls : null,
      metadata: { messageSid },
    });

    return new NextResponse(twiml.toString(), {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error: any) {
    console.error("Inbound SMS webhook error:", error);
    const MessagingResponse = twilio.twiml.MessagingResponse;
    const twiml = new MessagingResponse();
    return new NextResponse(twiml.toString(), {
      headers: { "Content-Type": "text/xml" },
    });
  }
}
