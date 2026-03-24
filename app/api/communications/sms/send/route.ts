import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getTwilioClient, getTwilioConfig } from "@/lib/twilio";
import {
  findCommConversationByPhone,
  createCommConversation,
  addCommMessage,
} from "@/lib/db/repositories/comm-conversations";
import { ensureCommunicationsTables } from "@/lib/db/init";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { to, message, mediaUrls } = body;

    if (!to || !message) {
      return NextResponse.json(
        { error: "Missing required fields: to, message" },
        { status: 400 }
      );
    }

    const config = getTwilioConfig();
    if (!config.phoneNumber) {
      return NextResponse.json(
        { error: "Twilio phone number not configured" },
        { status: 500 }
      );
    }

    const client = getTwilioClient();

    const twilioMessage = await client.messages.create({
      body: message,
      from: config.phoneNumber,
      to,
      ...(mediaUrls && mediaUrls.length > 0 ? { mediaUrl: mediaUrls } : {}),
    });

    await ensureCommunicationsTables();

    let conversation = await findCommConversationByPhone(session.shopId, to, "sms");
    if (!conversation) {
      conversation = await createCommConversation({
        shop_id: session.shopId,
        channel: "sms",
        direction: "outbound",
        customer_phone: to,
        assigned_user_email: session.email,
        status: "active",
        subject: `SMS conversation with ${to}`,
      });
    }

    await addCommMessage({
      conversation_id: conversation.id,
      channel: "sms",
      direction: "outbound",
      from_number: config.phoneNumber,
      to_number: to,
      body: message,
      media_urls: mediaUrls || null,
      metadata: { messageSid: twilioMessage.sid },
    });

    return NextResponse.json({
      success: true,
      messageSid: twilioMessage.sid,
      conversationId: conversation.id,
    });
  } catch (error: any) {
    console.error("SMS send error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to send SMS" },
      { status: 500 }
    );
  }
}
