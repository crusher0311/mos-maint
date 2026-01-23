import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getSessionById, linkSessionToTicket } from "@/lib/support-chat";
import { getDb } from "@/lib/mongo";
import { sendEmail, makeTicketCreatedEmail, makeNewTicketAdminEmail } from "@/lib/email";
import { createNotification } from "@/lib/notifications";
import { SUPER_ADMIN_EMAILS } from "@/lib/super-admins";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { sessionId, subject } = body;

  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "Session ID is required" }, { status: 400 });
  }

  const chatSession = await getSessionById(sessionId);
  if (!chatSession || chatSession.userEmail !== session.email) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }

  const chatHistory = chatSession.messages
    .map(m => `${m.role === "user" ? "User" : "AI Assistant"}: ${m.content}`)
    .join("\n\n");

  const ticketSubject = subject || "Escalated from AI Chat Support";
  const ticketDescription = `This ticket was escalated from AI chat support.\n\n--- Chat History ---\n\n${chatHistory}`;

  const db = await getDb();
  const now = new Date();
  const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;

  let shopName = null;
  if (session.shopId) {
    const shop = await db.collection("shops").findOne({ id: session.shopId });
    shopName = shop?.name || null;
  }

  const result = await db.collection("support_tickets").insertOne({
    ticketNumber,
    userEmail: session.email,
    userName: session.email.split("@")[0],
    shopId: session.shopId,
    shopName,
    subject: ticketSubject,
    description: ticketDescription,
    status: "open",
    priority: "medium",
    category: "general",
    messages: [],
    createdAt: now,
    updatedAt: now,
    escalatedFromChat: sessionId
  });

  const ticketId = result.insertedId.toString();
  await linkSessionToTicket(sessionId, ticketId);

  const ticketEmail = makeTicketCreatedEmail(ticketNumber, ticketSubject, "general");
  await sendEmail({ to: session.email, ...ticketEmail });

  await createNotification({
    userId: session.email,
    type: "ticket_created",
    title: "Support Ticket Created",
    message: `Your ticket ${ticketNumber} has been escalated from chat support.`,
    link: `/support/tickets/${ticketId}`
  });

  for (const adminEmail of SUPER_ADMIN_EMAILS) {
    const adminEmailContent = makeNewTicketAdminEmail(ticketNumber, ticketSubject, "general", "medium", "Escalated from Chat");
    await sendEmail({ to: adminEmail, ...adminEmailContent });
    await createNotification({
      userId: `admin:${adminEmail}`,
      type: "system",
      title: "New Escalated Ticket",
      message: `${session.email} escalated chat to ticket: ${ticketSubject}`,
      link: `/platform-admin/tickets/${ticketId}`
    });
  }

  return NextResponse.json({
    ok: true,
    ticketId,
    ticketNumber
  });
}
