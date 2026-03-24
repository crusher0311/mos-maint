import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  listCommConversations,
  createCommConversation,
} from "@/lib/db/repositories/comm-conversations";
import { ensureCommunicationsTables } from "@/lib/db/init";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureCommunicationsTables();

    const { searchParams } = req.nextUrl;
    const status = searchParams.get("status") || undefined;
    const channel = searchParams.get("channel") || undefined;
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    const conversations = await listCommConversations({
      shop_id: session.shopId,
      status,
      channel,
      limit,
      offset,
    });

    return NextResponse.json({ conversations });
  } catch (error: any) {
    console.error("List conversations error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to list conversations" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureCommunicationsTables();

    const body = await req.json();

    if (!body.customer_phone || !body.channel) {
      return NextResponse.json(
        { error: "Missing required fields: customer_phone, channel" },
        { status: 400 }
      );
    }

    const conversation = await createCommConversation({
      shop_id: session.shopId,
      channel: body.channel,
      direction: body.direction || "outbound",
      customer_phone: body.customer_phone,
      customer_name: body.customer_name || null,
      customer_id: body.customer_id || null,
      assigned_user_email: session.email,
      subject: body.subject || null,
      status: body.status || "active",
      metadata: body.metadata || null,
    });

    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error: any) {
    console.error("Create conversation error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to create conversation" },
      { status: 500 }
    );
  }
}
