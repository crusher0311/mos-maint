import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";
import { sendEmail, makeTicketCreatedEmail, makeNewTicketAdminEmail } from "@/lib/email";
import { createNotificationsForUsers } from "@/lib/notifications";
import { getPlatformAdminEmails } from "@/lib/super-admins";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();

    const tickets = await db.collection("support_tickets")
      .find({ userEmail: session.email })
      .sort({ createdAt: -1 })
      .toArray();

    return NextResponse.json({
      ok: true,
      tickets
    });
  } catch (error: any) {
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

    const db = await getDb();

    let shopId = session.shopId || null;
    let shopName = null;
    let locationIdentifier = null;
    
    if (shopId) {
      // Use the session's current shop
      const shop = await db.collection("shops").findOne({ shopId });
      shopName = shop?.name || null;
      locationIdentifier = shop?.locationIdentifier || null;
    } else {
      // Fallback: look up user's shop associations (same logic as /api/user/shops)
      const userRecords = await db
        .collection("users")
        .find({ email: session.email.toLowerCase() })
        .project({ shopId: 1 })
        .toArray();
      
      const shopIds = [...new Set(userRecords.map((u) => Number(u.shopId)))];
      
      if (shopIds.length === 1) {
        // User has exactly one shop - use it
        shopId = shopIds[0];
        const shop = await db.collection("shops").findOne({ shopId });
        shopName = shop?.name || null;
        locationIdentifier = shop?.locationIdentifier || null;
      } else if (shopIds.length > 1) {
        // User has multiple shops - get all shop names for context
        const shops = await db
          .collection("shops")
          .find({ shopId: { $in: shopIds } })
          .project({ shopId: 1, name: 1, locationIdentifier: 1 })
          .toArray();
        
        // Store all shop names in locationIdentifier for admin visibility
        const shopDisplayNames = shops.map(s => 
          s.locationIdentifier || s.name || `Shop ${s.shopId}`
        );
        locationIdentifier = `Multiple: ${shopDisplayNames.join(", ")}`;
      }
    }

    const ticketCount = await db.collection("support_tickets").countDocuments();
    const ticketNumber = `TKT-${String(ticketCount + 1).padStart(5, "0")}`;

    const ticket = {
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
      locationIdentifier,
      assignedTo: null,
      messages: [{
        id: new ObjectId().toString(),
        from: "user",
        fromEmail: session.email,
        fromName: session.email.split("@")[0],
        message: description,
        createdAt: new Date()
      }],
      createdAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: null,
      closedAt: null
    };

    const result = await db.collection("support_tickets").insertOne(ticket);

    try {
      const { getDb: getSupabaseDb } = await import("@/lib/db/drizzle");
      const { supportTickets } = await import("@/lib/db/schema/support-tickets");
      const pgDb = getSupabaseDb();
      const validCategories = ["technical", "billing", "integration", "feature_request", "general"] as const;
      const validPriorities = ["low", "medium", "high", "urgent"] as const;
      const pgCategory = validCategories.includes(ticket.category as any) ? ticket.category : "general";
      const pgPriority = validPriorities.includes(ticket.priority as any) ? ticket.priority : "medium";
      await pgDb.insert(supportTickets).values({
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        description: ticket.description,
        category: pgCategory as any,
        priority: pgPriority as any,
        status: "open",
        source: "web",
        shopId: ticket.shopId != null ? Number(ticket.shopId) : null,
        shopName: ticket.shopName,
        locationIdentifier: ticket.locationIdentifier,
        userEmail: ticket.userEmail,
        userName: ticket.userName,
        messages: ticket.messages,
      });
    } catch (pgErr) {
      console.error("Supabase ticket dual-write failed (non-blocking):", pgErr);
    }

    const categoryLabels: Record<string, string> = {
      general: "General",
      billing: "Billing",
      technical: "Technical Support",
      feature_request: "Feature Request",
      bug: "Bug Report",
      account: "Account"
    };
    const categoryLabel = categoryLabels[ticket.category] || ticket.category;

    const priorityLabels: Record<string, string> = {
      low: "Low",
      medium: "Medium",
      high: "High",
      urgent: "Urgent"
    };
    const priorityLabel = priorityLabels[ticket.priority] || ticket.priority;

    try {
      const userEmailContent = makeTicketCreatedEmail(ticketNumber, subject, categoryLabel);
      await sendEmail({
        to: session.email,
        subject: userEmailContent.subject,
        html: userEmailContent.html,
        text: userEmailContent.text,
        shopId: session.shopId,
        emailKind: "ticket_created",
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
        link: `/platform-admin/tickets?id=${result.insertedId}`,
        metadata: { ticketId: result.insertedId.toString(), ticketNumber }
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
      ticket: { ...ticket, _id: result.insertedId },
      ticketNumber
    });
  } catch (error: any) {
    console.error("Error creating ticket:", error);
    return NextResponse.json({ error: "Failed to create ticket" }, { status: 500 });
  }
}
