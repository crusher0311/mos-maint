import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";
import { createNotificationsForUsers } from "@/lib/notifications";
import { SUPER_ADMINS } from "@/lib/super-admins";

export async function GET(
  request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { ticketId } = params;

    if (!ticketId || !ObjectId.isValid(ticketId)) {
      return NextResponse.json({ error: "Invalid ticket ID" }, { status: 400 });
    }

    const db = await getDb();

    const ticket = await db.collection("support_tickets").findOne({
      _id: new ObjectId(ticketId),
      userEmail: user.email
    });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      ticket
    });
  } catch (error: any) {
    console.error("Error fetching ticket:", error);
    return NextResponse.json({ error: "Failed to fetch ticket" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { ticketId } = params;
    const body = await request.json();
    const { message } = body;

    if (!message) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    if (!ticketId || !ObjectId.isValid(ticketId)) {
      return NextResponse.json({ error: "Invalid ticket ID" }, { status: 400 });
    }

    const db = await getDb();

    const ticket = await db.collection("support_tickets").findOne({
      _id: new ObjectId(ticketId),
      userEmail: user.email
    });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    if (ticket.status === "closed") {
      return NextResponse.json({ error: "Cannot reply to a closed ticket" }, { status: 400 });
    }

    const result = await db.collection("support_tickets").findOneAndUpdate(
      { _id: new ObjectId(ticketId), userEmail: user.email },
      {
        $set: { updatedAt: new Date() },
        $push: {
          messages: {
            id: new ObjectId().toString(),
            from: "user",
            fromEmail: user.email,
            fromName: user.name || user.email.split("@")[0],
            message,
            createdAt: new Date()
          }
        }
      },
      { returnDocument: "after" }
    );

    try {
      const adminUserIds = SUPER_ADMINS.map(email => `admin:${email}`);
      await createNotificationsForUsers(adminUserIds, {
        type: "ticket_message",
        title: `User Reply: ${ticket.ticketNumber}`,
        message: message.substring(0, 100) + (message.length > 100 ? "..." : ""),
        link: `/platform-admin/tickets?id=${ticketId}`,
        metadata: { ticketId, ticketNumber: ticket.ticketNumber }
      });
    } catch (notifErr) {
      console.error("Failed to create admin notifications:", notifErr);
    }

    return NextResponse.json({
      ok: true,
      ticket: result
    });
  } catch (error: any) {
    console.error("Error adding reply:", error);
    return NextResponse.json({ error: "Failed to add reply" }, { status: 500 });
  }
}
