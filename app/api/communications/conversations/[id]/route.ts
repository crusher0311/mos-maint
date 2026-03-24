import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getCommConversation,
  updateCommConversation,
  getCommMessages,
} from "@/lib/db/repositories/comm-conversations";
import { ensureCommunicationsTables } from "@/lib/db/init";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureCommunicationsTables();

    const conversation = await getCommConversation(params.id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    if (conversation.shop_id !== session.shopId && !session.isPlatformAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const limit = parseInt(req.nextUrl.searchParams.get("messageLimit") || "100", 10);
    const messages = await getCommMessages(params.id, limit);

    return NextResponse.json({ conversation, messages });
  } catch (error: any) {
    console.error("Get conversation error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to get conversation" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureCommunicationsTables();

    const existing = await getCommConversation(params.id);
    if (!existing) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }

    if (existing.shop_id !== session.shopId && !session.isPlatformAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();

    const conversation = await updateCommConversation(params.id, {
      status: body.status,
      customer_name: body.customer_name,
      customer_id: body.customer_id,
      assigned_user_email: body.assigned_user_email,
      subject: body.subject,
      metadata: body.metadata,
      closed_at: body.status === "closed" ? new Date().toISOString() : undefined,
    });

    return NextResponse.json({ conversation });
  } catch (error: any) {
    console.error("Update conversation error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update conversation" },
      { status: 500 }
    );
  }
}
