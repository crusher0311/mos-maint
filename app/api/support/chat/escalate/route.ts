import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getSessionById, linkSessionToTicket } from "@/lib/support-chat";
import sql from "@/lib/db/postgres";
import { sendEmail, makeTicketCreatedEmail, makeNewTicketAdminEmail } from "@/lib/email";
import { createNotification } from "@/lib/notifications";
import { getPlatformAdminEmails } from "@/lib/super-admins";

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

  const now = new Date();
  const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;

  let shopName = null;
  let locationIdentifier = null;
  if (session.shopId) {
    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${String(session.shopId)}`;
    const shop = shopRows[0] as any;
    shopName = shop?.name || null;
    locationIdentifier = shop?.location_identifier || null;
  }

  const result = await sql`
    INSERT INTO support_tickets (
      ticket_number, user_email, user_name, shop_id, shop_name, location_identifier,
      subject, description, status, priority, category, messages,
      created_at, updated_at, escalated_from_chat
    ) VALUES (
      ${ticketNumber}, ${session.email}, ${session.email.split("@")[0]}, ${session.shopId ? String(session.shopId) : null},
      ${shopName}, ${locationIdentifier}, ${ticketSubject}, ${ticketDescription},
      'open', 'medium', 'general', '[]'::jsonb, ${now}, ${now}, ${sessionId}
    ) RETURNING id
  `;

  const ticketId = (result[0] as any).id;
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

  const platformAdminEmails = await getPlatformAdminEmails();
  for (let i = 0; i < platformAdminEmails.length; i++) {
    const adminEmail = platformAdminEmails[i];
    if (i > 0) {
      await new Promise(r => setTimeout(r, 600));
    }
    try {
      const adminEmailContent = makeNewTicketAdminEmail(ticketNumber, ticketSubject, "general", "medium", "Escalated from Chat");
      await sendEmail({ to: adminEmail, ...adminEmailContent });
      await createNotification({
        userId: `admin:${adminEmail}`,
        type: "system",
        title: "New Escalated Ticket",
        message: `${session.email} escalated chat to ticket: ${ticketSubject}`,
        link: `/platform-admin/tickets/${ticketId}`
      });
    } catch (adminEmailErr) {
      console.error(`Failed to send admin email to ${adminEmail}:`, adminEmailErr);
    }
  }

  return NextResponse.json({
    ok: true,
    ticketId,
    ticketNumber
  });
}
