import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";
import { createNotificationsForUsers } from "@/lib/notifications";
import { SUPER_ADMIN_EMAILS } from "@/lib/super-admins";
import { sendEmail } from "@/lib/email";

export async function GET(
  request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { ticketId } = params;

    if (!ticketId || !ObjectId.isValid(ticketId)) {
      return NextResponse.json({ error: "Invalid ticket ID" }, { status: 400 });
    }

    const db = await getDb();

    const ticket = await db.collection("support_tickets").findOne({
      _id: new ObjectId(ticketId),
      userEmail: session.email
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
    const session = await getSession();
    if (!session) {
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
      userEmail: session.email
    });

    if (!ticket) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    if (ticket.status === "closed") {
      return NextResponse.json({ error: "Cannot reply to a closed ticket" }, { status: 400 });
    }

    const result = await db.collection("support_tickets").findOneAndUpdate(
      { _id: new ObjectId(ticketId), userEmail: session.email },
      {
        $set: { updatedAt: new Date() },
        $push: {
          messages: {
            id: new ObjectId().toString(),
            from: "user",
            fromEmail: session.email,
            fromName: session.name || session.email.split("@")[0],
            message,
            createdAt: new Date()
          }
        }
      },
      { returnDocument: "after" }
    );

    try {
      const adminUserIds = SUPER_ADMIN_EMAILS.map(email => `admin:${email}`);
      await createNotificationsForUsers(adminUserIds, {
        type: "ticket_message",
        title: `User Reply: ${ticket.ticketNumber}`,
        message: message.substring(0, 100) + (message.length > 100 ? "..." : ""),
        link: `/platform-admin/tickets?id=${ticketId}`,
        metadata: { ticketId, ticketNumber: ticket.ticketNumber }
      });

      for (const adminEmail of SUPER_ADMIN_EMAILS) {
        try {
          await sendEmail({
            to: adminEmail,
            subject: `[MOS Support] Reply on ${ticket.ticketNumber}: ${ticket.subject}`,
            html: `
              <div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5">
                <h2>New Reply on Support Ticket ${ticket.ticketNumber}</h2>
                <p><strong>From:</strong> ${session.email}</p>
                <p><strong>Subject:</strong> ${ticket.subject}</p>
                <p><strong>Category:</strong> ${ticket.category}</p>
                <hr style="border:none;border-top:1px solid #e5e5e5;margin:16px 0">
                <p><strong>Message:</strong></p>
                <p style="background:#f5f5f5;padding:12px;border-radius:4px">${message.replace(/\n/g, '<br>')}</p>
                <p style="margin-top:16px">
                  <a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://mostools.io'}/platform-admin/tickets?id=${ticketId}" 
                     style="background:#2563eb;color:white;padding:8px 16px;border-radius:4px;text-decoration:none">
                    View Ticket
                  </a>
                </p>
              </div>
            `,
            text: `New reply on ticket ${ticket.ticketNumber} from ${session.email}:\n\n${message}`,
            replyTo: session.email
          });
        } catch (emailErr) {
          console.error(`Failed to send email to ${adminEmail}:`, emailErr);
        }
      }
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
