import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import { sendEmail, makeTicketUpdatedEmail } from "@/lib/email";
import { createNotification, clearTicketNotifications } from "@/lib/notifications";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const priority = searchParams.get("priority");
    const category = searchParams.get("category");
    const search = searchParams.get("search");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "50");

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const autoCloseResult = await sql`
      UPDATE support_tickets
      SET status = 'closed', closed_at = NOW(), auto_closed_at = NOW(), updated_at = NOW()
      WHERE status = 'resolved'
        AND resolved_at < ${twentyFourHoursAgo}
        AND updated_at < ${twentyFourHoursAgo}
    `;
    
    if (autoCloseResult.count > 0) {
      console.log(`Auto-closed ${autoCloseResult.count} resolved tickets after 24h inactivity`);
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    
    if (status && status !== "all") {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    if (priority && priority !== "all") {
      conditions.push(`priority = $${params.length + 1}`);
      params.push(priority);
    }
    if (category && category !== "all") {
      conditions.push(`category = $${params.length + 1}`);
      params.push(category);
    }

    const offset = (page - 1) * limit;

    let tickets;
    let totalCount;
    
    if (search) {
      const searchPattern = `%${search}%`;
      if (conditions.length > 0) {
        tickets = await sql`
          SELECT * FROM support_tickets
          WHERE ${sql.unsafe(conditions.join(' AND '))}
            AND (subject ILIKE ${searchPattern} 
              OR description ILIKE ${searchPattern} 
              OR user_email ILIKE ${searchPattern}
              OR ticket_number ILIKE ${searchPattern})
          ORDER BY created_at DESC
          OFFSET ${offset} LIMIT ${limit}
        `;
        const countResult = await sql`
          SELECT COUNT(*) as count FROM support_tickets
          WHERE ${sql.unsafe(conditions.join(' AND '))}
            AND (subject ILIKE ${searchPattern} 
              OR description ILIKE ${searchPattern} 
              OR user_email ILIKE ${searchPattern}
              OR ticket_number ILIKE ${searchPattern})
        `;
        totalCount = Number(countResult[0]?.count || 0);
      } else {
        tickets = await sql`
          SELECT * FROM support_tickets
          WHERE subject ILIKE ${searchPattern} 
            OR description ILIKE ${searchPattern} 
            OR user_email ILIKE ${searchPattern}
            OR ticket_number ILIKE ${searchPattern}
          ORDER BY created_at DESC
          OFFSET ${offset} LIMIT ${limit}
        `;
        const countResult = await sql`
          SELECT COUNT(*) as count FROM support_tickets
          WHERE subject ILIKE ${searchPattern} 
            OR description ILIKE ${searchPattern} 
            OR user_email ILIKE ${searchPattern}
            OR ticket_number ILIKE ${searchPattern}
        `;
        totalCount = Number(countResult[0]?.count || 0);
      }
    } else if (conditions.length > 0) {
      if (status && status !== "all" && priority && priority !== "all" && category && category !== "all") {
        tickets = await sql`
          SELECT * FROM support_tickets WHERE status = ${status} AND priority = ${priority} AND category = ${category}
          ORDER BY created_at DESC OFFSET ${offset} LIMIT ${limit}
        `;
        const countResult = await sql`
          SELECT COUNT(*) as count FROM support_tickets WHERE status = ${status} AND priority = ${priority} AND category = ${category}
        `;
        totalCount = Number(countResult[0]?.count || 0);
      } else if (status && status !== "all" && priority && priority !== "all") {
        tickets = await sql`
          SELECT * FROM support_tickets WHERE status = ${status} AND priority = ${priority}
          ORDER BY created_at DESC OFFSET ${offset} LIMIT ${limit}
        `;
        const countResult = await sql`
          SELECT COUNT(*) as count FROM support_tickets WHERE status = ${status} AND priority = ${priority}
        `;
        totalCount = Number(countResult[0]?.count || 0);
      } else if (status && status !== "all" && category && category !== "all") {
        tickets = await sql`
          SELECT * FROM support_tickets WHERE status = ${status} AND category = ${category}
          ORDER BY created_at DESC OFFSET ${offset} LIMIT ${limit}
        `;
        const countResult = await sql`
          SELECT COUNT(*) as count FROM support_tickets WHERE status = ${status} AND category = ${category}
        `;
        totalCount = Number(countResult[0]?.count || 0);
      } else if (priority && priority !== "all" && category && category !== "all") {
        tickets = await sql`
          SELECT * FROM support_tickets WHERE priority = ${priority} AND category = ${category}
          ORDER BY created_at DESC OFFSET ${offset} LIMIT ${limit}
        `;
        const countResult = await sql`
          SELECT COUNT(*) as count FROM support_tickets WHERE priority = ${priority} AND category = ${category}
        `;
        totalCount = Number(countResult[0]?.count || 0);
      } else if (status && status !== "all") {
        tickets = await sql`
          SELECT * FROM support_tickets WHERE status = ${status}
          ORDER BY created_at DESC OFFSET ${offset} LIMIT ${limit}
        `;
        const countResult = await sql`
          SELECT COUNT(*) as count FROM support_tickets WHERE status = ${status}
        `;
        totalCount = Number(countResult[0]?.count || 0);
      } else if (priority && priority !== "all") {
        tickets = await sql`
          SELECT * FROM support_tickets WHERE priority = ${priority}
          ORDER BY created_at DESC OFFSET ${offset} LIMIT ${limit}
        `;
        const countResult = await sql`
          SELECT COUNT(*) as count FROM support_tickets WHERE priority = ${priority}
        `;
        totalCount = Number(countResult[0]?.count || 0);
      } else {
        tickets = await sql`
          SELECT * FROM support_tickets WHERE category = ${category}
          ORDER BY created_at DESC OFFSET ${offset} LIMIT ${limit}
        `;
        const countResult = await sql`
          SELECT COUNT(*) as count FROM support_tickets WHERE category = ${category}
        `;
        totalCount = Number(countResult[0]?.count || 0);
      }
    } else {
      tickets = await sql`
        SELECT * FROM support_tickets
        ORDER BY created_at DESC
        OFFSET ${offset} LIMIT ${limit}
      `;
      const countResult = await sql`SELECT COUNT(*) as count FROM support_tickets`;
      totalCount = Number(countResult[0]?.count || 0);
    }

    const shopIds = tickets
      .filter((t: Record<string, unknown>) => t.shop_id && !t.shop_name)
      .map((t: Record<string, unknown>) => String(t.shop_id));
    
    let shopMap: Record<string, string> = {};
    if (shopIds.length > 0) {
      const shops = await sql`
        SELECT shop_id, name FROM shops WHERE shop_id = ANY(${shopIds})
      `;
      shopMap = shops.reduce((acc: Record<string, string>, shop: Record<string, unknown>) => {
        acc[String(shop.shop_id)] = shop.name as string;
        return acc;
      }, {} as Record<string, string>);
    }

    const formattedTickets = tickets.map((ticket: Record<string, unknown>) => ({
      _id: ticket.id,
      ticketNumber: ticket.ticket_number,
      subject: ticket.subject,
      description: ticket.description,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      userEmail: ticket.user_email,
      userName: ticket.user_name,
      shopId: ticket.shop_id,
      shopName: ticket.shop_name || (ticket.shop_id ? shopMap[String(ticket.shop_id)] : null) || null,
      assignedTo: ticket.assigned_to,
      messages: ticket.messages || [],
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
      resolvedAt: ticket.resolved_at,
      closedAt: ticket.closed_at,
    }));

    const stats = await sql`
      SELECT status, COUNT(*) as count FROM support_tickets GROUP BY status
    `;

    const statusCounts = {
      open: 0,
      in_progress: 0,
      resolved: 0,
      closed: 0
    };

    for (const s of stats) {
      const statusKey = s.status as keyof typeof statusCounts;
      if (statusKey in statusCounts) {
        statusCounts[statusKey] = Number(s.count);
      }
    }

    return NextResponse.json({
      ok: true,
      tickets: formattedTickets,
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      stats: statusCounts
    });
  } catch (error: unknown) {
    console.error("Error fetching tickets:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch tickets" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const body = await request.json();
    const { subject, description, category, priority, userEmail, userName, shopId, shopName } = body;

    if (!subject || !description || !userEmail) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const ticketCountResult = await sql`SELECT COUNT(*) as count FROM support_tickets`;
    const ticketCount = Number(ticketCountResult[0]?.count || 0);
    const ticketNumber = `TKT-${String(ticketCount + 1).padStart(5, "0")}`;

    const messages = [{
      id: crypto.randomUUID(),
      from: "user",
      fromEmail: userEmail,
      fromName: userName || userEmail.split("@")[0],
      message: description,
      createdAt: new Date().toISOString()
    }];

    const result = await sql`
      INSERT INTO support_tickets (
        ticket_number, subject, description, category, priority, status,
        user_email, user_name, shop_id, shop_name, assigned_to, messages
      )
      VALUES (
        ${ticketNumber},
        ${subject},
        ${description},
        ${category || "general"},
        ${priority || "medium"},
        'open',
        ${userEmail},
        ${userName || userEmail.split("@")[0]},
        ${shopId || null},
        ${shopName || null},
        ${null},
        ${JSON.stringify(messages)}
      )
      RETURNING *
    `;

    const ticket = result[0];

    return NextResponse.json({
      ok: true,
      ticket: {
        _id: ticket.id,
        ticketNumber: ticket.ticket_number,
        subject: ticket.subject,
        description: ticket.description,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        userEmail: ticket.user_email,
        userName: ticket.user_name,
        shopId: ticket.shop_id,
        shopName: ticket.shop_name,
        messages: ticket.messages,
        createdAt: ticket.created_at,
      },
      ticketNumber
    });
  } catch (error: unknown) {
    console.error("Error creating ticket:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to create ticket" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await requirePlatformAdmin();

    const body = await request.json();
    const { ticketId, status, priority, assignedTo, message, resolutionNotes } = body;

    if (!ticketId) {
      return NextResponse.json({ error: "Missing ticket ID" }, { status: 400 });
    }

    const numTicketId = Number(ticketId);
    if (isNaN(numTicketId)) {
      return NextResponse.json({ error: "Invalid ticket ID format" }, { status: 400 });
    }

    const existingResult = await sql`SELECT * FROM support_tickets WHERE id = ${numTicketId}`;
    if (existingResult.length === 0) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }
    const existingTicket = existingResult[0];

    const updateFields: Record<string, unknown> = {};

    if (status) {
      updateFields.status = status;
      if (status === "resolved") {
        updateFields.resolved_at = new Date();
        updateFields.resolved_by = session.email;
        if (resolutionNotes) {
          updateFields.resolution_notes = resolutionNotes;
        }
        await clearTicketNotifications(String(ticketId));
      }
      if (status === "closed") {
        updateFields.closed_at = new Date();
        updateFields.closed_by = session.email;
        if (resolutionNotes) {
          updateFields.resolution_notes = resolutionNotes;
        }
        await clearTicketNotifications(String(ticketId));
      }
    }

    if (priority) {
      updateFields.priority = priority;
    }

    if (assignedTo !== undefined) {
      updateFields.assigned_to = assignedTo;
    }

    let updatedMessages = existingTicket.messages || [];
    if (message) {
      const newMessage = {
        id: crypto.randomUUID(),
        from: "admin",
        fromEmail: session.email,
        fromName: session.email.split("@")[0],
        message,
        createdAt: new Date().toISOString()
      };
      updatedMessages = [...updatedMessages, newMessage];
      updateFields.messages = JSON.stringify(updatedMessages);
    }

    if (Object.keys(updateFields).length > 0) {
      await sql`
        UPDATE support_tickets
        SET ${sql(updateFields)}, updated_at = NOW()
        WHERE id = ${numTicketId}
      `;
    }

    const result = await sql`SELECT * FROM support_tickets WHERE id = ${numTicketId}`;
    const ticket = result[0];

    const statusLabels: Record<string, string> = {
      open: "Open",
      in_progress: "In Progress",
      resolved: "Resolved",
      closed: "Closed"
    };
    const statusLabel = statusLabels[ticket.status] || ticket.status;

    if (ticket.user_email && (status || message)) {
      try {
        const emailContent = makeTicketUpdatedEmail(
          ticket.ticket_number,
          ticket.subject,
          statusLabel,
          message || undefined
        );
        await sendEmail({
          to: ticket.user_email,
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text
        });
      } catch (emailErr) {
        console.error("Failed to send ticket update email:", emailErr);
      }

      try {
        const shopUser = await sql`
          SELECT id FROM users WHERE email = ${ticket.user_email} LIMIT 1
        `;
        const userId = shopUser[0]?.id?.toString() || ticket.user_email;
        
        await createNotification({
          userId,
          shopId: ticket.shop_id,
          type: status === "resolved" ? "ticket_resolved" : message ? "ticket_message" : "ticket_updated",
          title: status === "resolved" 
            ? `Ticket Resolved: ${ticket.ticket_number}`
            : message 
              ? `New Reply: ${ticket.ticket_number}`
              : `Ticket Updated: ${ticket.ticket_number}`,
          message: message 
            ? message.substring(0, 100) + (message.length > 100 ? "..." : "")
            : `Status changed to ${statusLabel}`,
          link: `/dashboard/support?id=${ticketId}`,
          metadata: { ticketId: String(ticketId), ticketNumber: ticket.ticket_number }
        });
      } catch (notifErr) {
        console.error("Failed to create user notification:", notifErr);
      }
    }

    return NextResponse.json({
      ok: true,
      ticket: {
        _id: ticket.id,
        ticketNumber: ticket.ticket_number,
        subject: ticket.subject,
        description: ticket.description,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        userEmail: ticket.user_email,
        userName: ticket.user_name,
        shopId: ticket.shop_id,
        shopName: ticket.shop_name,
        messages: ticket.messages,
        createdAt: ticket.created_at,
        updatedAt: ticket.updated_at,
        resolvedAt: ticket.resolved_at,
        closedAt: ticket.closed_at,
      }
    });
  } catch (error: unknown) {
    console.error("Error updating ticket:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to update ticket" }, { status: 500 });
  }
}
