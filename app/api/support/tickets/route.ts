import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { sendEmail, makeTicketCreatedEmail, makeNewTicketAdminEmail } from "@/lib/email";
import { createNotificationsForUsers } from "@/lib/notifications";
import { getPlatformAdminEmails } from "@/lib/super-admins";
import { v4 as uuidv4 } from "uuid";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const tickets = await sql`
      SELECT * FROM support_tickets 
      WHERE user_email = ${session.email}
      ORDER BY created_at DESC NULLS LAST
    `;

    return NextResponse.json({
      ok: true,
      tickets: tickets.map(t => ({
        _id: t.id,
        ticketNumber: t.ticket_number,
        subject: t.subject,
        description: t.description,
        category: t.category,
        priority: t.priority,
        status: t.status,
        userEmail: t.user_email,
        userName: t.user_name,
        shopId: t.shop_id,
        shopName: t.shop_name,
        messages: t.messages,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        resolvedAt: t.resolved_at,
        closedAt: t.closed_at,
      }))
    });
  } catch (error: unknown) {
    console.error("Error fetching user tickets:", error);
    return NextResponse.json({ error: "Failed to fetch tickets" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { subject, description, category, priority } = body;

    if (!subject || !description) {
      return NextResponse.json({ error: "Subject and description are required" }, { status: 400 });
    }

    let shopId = session.shopId || null;
    let shopName: string | null = null;
    let locationIdentifier: string | null = null;
    
    if (shopId) {
      const shopResult = await sql`SELECT name, location_identifier FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1`;
      const shop = shopResult[0];
      shopName = shop?.name || null;
      locationIdentifier = shop?.location_identifier || null;
    } else {
      const userRecords = await sql`
        SELECT shop_id FROM users WHERE email = ${session.email.toLowerCase()}
      `;
      
      const shopIds = [...new Set(userRecords.map(u => u.shop_id))];
      
      if (shopIds.length === 1) {
        shopId = shopIds[0];
        const shopResult = await sql`SELECT name, location_identifier FROM shops WHERE shop_id = ${String(shopId)} LIMIT 1`;
        const shop = shopResult[0];
        shopName = shop?.name || null;
        locationIdentifier = shop?.location_identifier || null;
      } else if (shopIds.length > 1) {
        const shops = await sql`
          SELECT shop_id, name, location_identifier FROM shops WHERE shop_id = ANY(${shopIds.map(String)})
        `;
        const shopDisplayNames = shops.map(s => s.location_identifier || s.name || `Shop ${s.shop_id}`);
        locationIdentifier = `Multiple: ${shopDisplayNames.join(", ")}`;
      }
    }

    const countResult = await sql<{count: string}[]>`SELECT COUNT(*) as count FROM support_tickets`;
    const ticketCount = parseInt(countResult[0]?.count || "0", 10);
    const ticketNumber = `TKT-${String(ticketCount + 1).padStart(5, "0")}`;

    const now = new Date();
    const messageId = uuidv4();
    const messages = [{
      id: messageId,
      from: "user",
      fromEmail: session.email,
      fromName: session.email.split("@")[0],
      message: description,
      createdAt: now.toISOString()
    }];

    const result = await sql`
      INSERT INTO support_tickets (
        ticket_number, subject, description, category, priority, status,
        user_email, user_name, shop_id, shop_name, location_identifier,
        assigned_to, messages, created_at, updated_at, resolved_at, closed_at
      )
      VALUES (
        ${ticketNumber}, ${subject}, ${description}, ${category || "general"}, ${priority || "medium"}, 'open',
        ${session.email}, ${session.email.split("@")[0]}, ${shopId}, ${shopName}, ${locationIdentifier},
        NULL, ${JSON.stringify(messages)}::jsonb, ${now}, ${now}, NULL, NULL
      )
      RETURNING id
    `;

    const ticketId = result[0].id;

    const categoryLabels: Record<string, string> = {
      general: "General",
      billing: "Billing",
      technical: "Technical Support",
      feature_request: "Feature Request",
      bug: "Bug Report",
      account: "Account"
    };
    const categoryLabel = categoryLabels[category || "general"] || category;

    const priorityLabels: Record<string, string> = {
      low: "Low",
      medium: "Medium",
      high: "High",
      urgent: "Urgent"
    };
    const priorityLabel = priorityLabels[priority || "medium"] || priority;

    try {
      const userEmailContent = makeTicketCreatedEmail(ticketNumber, subject, categoryLabel);
      await sendEmail({
        to: session.email,
        subject: userEmailContent.subject,
        html: userEmailContent.html,
        text: userEmailContent.text
      });
    } catch (emailErr) {
      console.error("Failed to send ticket confirmation email:", emailErr);
    }

    try {
      const platformAdminEmails = await getPlatformAdminEmails();
      const adminUserIds = platformAdminEmails.map(email => `admin:${email}`);
      await createNotificationsForUsers(adminUserIds, {
        type: "ticket_created",
        title: `New Ticket: ${ticketNumber}`,
        message: `${shopName || session.email} submitted: ${subject}`,
        link: `/platform-admin/tickets?id=${ticketId}`,
        metadata: { ticketId, ticketNumber }
      });
      
      for (let i = 0; i < platformAdminEmails.length; i++) {
        const adminEmail = platformAdminEmails[i];
        if (i > 0) {
          await new Promise(r => setTimeout(r, 600));
        }
        try {
          const adminEmailContent = makeNewTicketAdminEmail(
            ticketNumber,
            subject,
            categoryLabel,
            priorityLabel,
            shopName || session.email
          );
          await sendEmail({
            to: adminEmail,
            subject: adminEmailContent.subject,
            html: adminEmailContent.html,
            text: adminEmailContent.text
          });
        } catch (adminEmailErr) {
          console.error(`Failed to send admin email to ${adminEmail}:`, adminEmailErr);
        }
      }
    } catch (notifErr) {
      console.error("Failed to create admin notifications:", notifErr);
    }

    return NextResponse.json({
      ok: true,
      ticket: { 
        _id: ticketId, 
        ticketNumber, 
        subject, 
        description, 
        category: category || "general",
        priority: priority || "medium",
        status: "open",
        userEmail: session.email,
        userName: session.email.split("@")[0],
        shopId,
        shopName,
        messages,
        createdAt: now,
        updatedAt: now,
      },
      ticketNumber
    });
  } catch (error: unknown) {
    console.error("Error creating ticket:", error);
    return NextResponse.json({ error: "Failed to create ticket" }, { status: 500 });
  }
}
