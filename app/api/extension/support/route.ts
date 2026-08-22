import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus , buildAuthErrorBody } from "@/lib/extension-auth";
import { insertSupportTicket } from "@/lib/data/repositories/support-tickets";
import { findShopByExactShopId } from "@/lib/data/repositories/shops";
import {
  getOrCreateSession,
  addMessageToSession,
  generateAIResponse,
  getSessionById,
  markSessionResolved,
  linkSessionToTicket,
  ChatMessage,
} from "@/lib/support-chat";
import { sendEmail, makeTicketCreatedEmail, makeNewTicketAdminEmail } from "@/lib/email";
import { createNotification, createPlatformAdminNotification } from "@/lib/notifications";
import { getPlatformAdminEmails } from "@/lib/super-admins";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

async function _GET(request: NextRequest) {
  const auth = await validateExtensionToken(request);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      buildAuthErrorBody(auth, { ok: false }),
      { status: getAuthErrorStatus(auth), headers: CORS_HEADERS }
    );
  }

  try {
    const chatSession = await getOrCreateSession(auth.user.email, auth.user.shopId);
    return NextResponse.json(
      {
        ok: true,
        session: {
          sessionId: chatSession.sessionId,
          messages: chatSession.messages,
          resolved: chatSession.resolved,
        },
      },
      { headers: CORS_HEADERS }
    );
  } catch (error) {
    console.error("[Extension Support] Error fetching session:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to load chat session" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

async function _POST(request: NextRequest) {
  const auth = await validateExtensionToken(request);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(
      buildAuthErrorBody(auth, { ok: false }),
      { status: getAuthErrorStatus(auth), headers: CORS_HEADERS }
    );
  }

  const body = await request.json();
  const { action } = body;

  try {
    if (action === "chat") {
      return await handleChat(auth.user, body);
    } else if (action === "escalate") {
      return await handleEscalate(auth.user, body);
    } else if (action === "resolve") {
      return await handleResolve(auth.user, body);
    } else if (action === "ticket") {
      return await handleTicket(auth.user, body);
    } else {
      return NextResponse.json(
        { ok: false, error: "Invalid action" },
        { status: 400, headers: CORS_HEADERS }
      );
    }
  } catch (error: any) {
    console.error("[Extension Support] Error:", error);
    return NextResponse.json(
      { ok: false, error: error.message || "An error occurred" },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

async function handleChat(user: any, body: any) {
  const { message } = body;
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: "Message is required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const chatSession = await getOrCreateSession(user.email, user.shopId);

  const userMessage: ChatMessage = {
    role: "user",
    content: message.trim(),
    timestamp: new Date(),
  };

  await addMessageToSession(chatSession.sessionId, userMessage);

  const { response, articleIds } = await generateAIResponse(
    message.trim(),
    chatSession.messages,
    user.email
  );

  const assistantMessage: ChatMessage = {
    role: "assistant",
    content: response,
    timestamp: new Date(),
    articleIds,
  };

  await addMessageToSession(chatSession.sessionId, assistantMessage);

  return NextResponse.json(
    { ok: true, response, sessionId: chatSession.sessionId },
    { headers: CORS_HEADERS }
  );
}

async function handleEscalate(user: any, body: any) {
  const { sessionId, subject } = body;
  if (!sessionId) {
    return NextResponse.json(
      { ok: false, error: "Session ID is required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const chatSession = await getSessionById(sessionId);
  if (!chatSession || chatSession.userEmail !== user.email) {
    return NextResponse.json(
      { ok: false, error: "Session not found" },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  const chatHistory = chatSession.messages
    .map((m: any) => `${m.role === "user" ? "User" : "AI Assistant"}: ${m.content}`)
    .join("\n\n");

  const ticketSubject = subject || "Escalated from AI Chat Support (Extension)";
  const ticketDescription = `This ticket was escalated from AI chat support via the Chrome extension.\n\n--- Chat History ---\n\n${chatHistory}`;

  const now = new Date();
  const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;

  let shopName: string | null = null;
  let locationIdentifier: string | null = null;
  if (user.shopId) {
    const shop = await findShopByExactShopId(Number(user.shopId));
    shopName = shop?.name ?? null;
    locationIdentifier = shop?.locationIdentifier ?? null;
  }

  const insertedId = await insertSupportTicket({
    ticketNumber,
    userEmail: user.email,
    userName: user.email.split("@")[0],
    shopId: user.shopId,
    shopName,
    locationIdentifier,
    subject: ticketSubject,
    description: ticketDescription,
    status: "open",
    priority: "medium",
    category: "general",
    messages: [],
    createdAt: now,
    updatedAt: now,
    escalatedFromChat: sessionId,
    source: "extension",
  });

  const ticketId = insertedId.toString();
  await linkSessionToTicket(sessionId, ticketId);

  try {
    const ticketEmail = makeTicketCreatedEmail(ticketNumber, ticketSubject, "General");
    await sendEmail({ to: user.email, ...ticketEmail, shopId: user.shopId, emailKind: "ticket_created" });
  } catch (e) {
    console.error("[Extension Support] Failed to send ticket email:", e);
  }

  try {
    await createNotification({
      userId: user.email,
      type: "ticket_created",
      title: "Support Ticket Created",
      message: `Your ticket ${ticketNumber} has been escalated from chat support.`,
      link: `/support/tickets/${ticketId}`,
    });
  } catch (e) {
    console.error("[Extension Support] Failed to create notification:", e);
  }

  try {
    await createPlatformAdminNotification({
      logicalId: `system:${ticketId}`,
      type: "system",
      title: "New Escalated Ticket (Extension)",
      message: `${user.email} escalated chat to ticket: ${ticketSubject}`,
      link: `/platform-admin/tickets/${ticketId}`,
      metadata: { ticketId, ticketNumber, source: "extension-chat" },
    });
    const platformAdminEmails = await getPlatformAdminEmails();
    for (let i = 0; i < platformAdminEmails.length; i++) {
      const adminEmail = platformAdminEmails[i];
      if (i > 0) await new Promise((r) => setTimeout(r, 600));
      const adminEmailContent = makeNewTicketAdminEmail(ticketNumber, ticketSubject, "General", "Medium", "Escalated from Extension Chat");
      await sendEmail({ to: adminEmail, ...adminEmailContent });
    }
  } catch (e) {
    console.error("[Extension Support] Failed to notify admins:", e);
  }

  return NextResponse.json(
    { ok: true, ticketId, ticketNumber },
    { headers: CORS_HEADERS }
  );
}

async function handleResolve(user: any, body: any) {
  const { sessionId } = body;
  if (!sessionId) {
    return NextResponse.json(
      { ok: false, error: "Session ID is required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const chatSession = await getSessionById(sessionId);
  if (!chatSession || chatSession.userEmail !== user.email) {
    return NextResponse.json(
      { ok: false, error: "Session not found" },
      { status: 404, headers: CORS_HEADERS }
    );
  }

  await markSessionResolved(sessionId);
  return NextResponse.json({ ok: true }, { headers: CORS_HEADERS });
}

async function handleTicket(user: any, body: any) {
  const { subject, description, category, priority } = body;
  if (!subject || !description) {
    return NextResponse.json(
      { ok: false, error: "Subject and description are required" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const now = new Date();
  const ticketNumber = `TKT-${Date.now().toString(36).toUpperCase()}`;

  const shopId = user.shopId || null;
  let shopName: string | null = null;
  let locationIdentifier: string | null = null;
  if (shopId) {
    const shop = await findShopByExactShopId(Number(shopId));
    shopName = shop?.name ?? null;
    locationIdentifier = shop?.locationIdentifier ?? null;
  }

  const ticket = {
    ticketNumber,
    userEmail: user.email,
    userName: user.email.split("@")[0],
    shopId,
    shopName,
    locationIdentifier,
    subject,
    description,
    status: "open",
    priority: priority || "medium",
    category: category || "general",
    assignedTo: null,
    messages: [
      {
        id: Date.now().toString(36),
        from: "user",
        fromEmail: user.email,
        fromName: user.email.split("@")[0],
        message: description,
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    closedAt: null,
    source: "extension",
  };

  const insertedId = await insertSupportTicket(ticket);
  const ticketId = insertedId.toString();

  try {
    const categoryLabels: Record<string, string> = {
      general: "General",
      billing: "Billing",
      technical: "Technical Support",
      feature_request: "Feature Request",
      bug: "Bug Report",
      account: "Account",
    };
    const categoryLabel = categoryLabels[ticket.category] || ticket.category;
    const ticketEmail = makeTicketCreatedEmail(ticketNumber, subject, categoryLabel);
    await sendEmail({ to: user.email, ...ticketEmail, shopId: user.shopId, emailKind: "ticket_created" });
  } catch (e) {
    console.error("[Extension Support] Failed to send ticket email:", e);
  }

  try {
    await createPlatformAdminNotification({
      logicalId: `system:${ticketId}`,
      type: "system",
      title: "New Support Ticket (Extension)",
      message: `${user.email}: ${subject}`,
      link: `/platform-admin/tickets?id=${ticketId}`,
      metadata: { ticketId, ticketNumber, source: "extension" },
    });
    const platformAdminEmails = await getPlatformAdminEmails();
    for (let i = 0; i < platformAdminEmails.length; i++) {
      const adminEmail = platformAdminEmails[i];
      if (i > 0) await new Promise((r) => setTimeout(r, 600));
      const adminEmailContent = makeNewTicketAdminEmail(ticketNumber, subject, category || "General", priority || "Medium", "Extension");
      await sendEmail({ to: adminEmail, ...adminEmailContent });
    }
  } catch (e) {
    console.error("[Extension Support] Failed to notify admins:", e);
  }

  return NextResponse.json(
    { ok: true, ticketNumber },
    { headers: CORS_HEADERS }
  );
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
export const POST = withExtensionErrorMarker(_POST as any);
