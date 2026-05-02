import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";
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

    const db = await getDb();

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const autoCloseResult = await db.collection("support_tickets").updateMany(
      {
        status: "resolved",
        resolvedAt: { $lt: twentyFourHoursAgo },
        updatedAt: { $lt: twentyFourHoursAgo }
      },
      {
        $set: {
          status: "closed",
          closedAt: new Date(),
          autoClosedAt: new Date(),
          updatedAt: new Date()
        }
      }
    );
    
    if (autoCloseResult.modifiedCount > 0) {
      console.log(`Auto-closed ${autoCloseResult.modifiedCount} resolved tickets after 24h inactivity`);
    }

    const query: Record<string, any> = {};

    if (status && status !== "all") {
      query.status = status;
    }
    if (priority && priority !== "all") {
      query.priority = priority;
    }
    if (category && category !== "all") {
      query.category = category;
    }
    if (search) {
      query.$or = [
        { subject: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { userEmail: { $regex: search, $options: "i" } },
        { ticketNumber: { $regex: search, $options: "i" } }
      ];
    }

    const skip = (page - 1) * limit;

    const [rawTickets, totalCount] = await Promise.all([
      db.collection("support_tickets")
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      db.collection("support_tickets").countDocuments(query)
    ]);

    const shopIds = rawTickets
      .filter(t => t.shopId && !t.shopName)
      .map(t => t.shopId);
    
    let shopMap: Record<number, { name: string; locationIdentifier?: string }> = {};
    if (shopIds.length > 0) {
      const shops = await db.collection("shops")
        .find({ id: { $in: shopIds } })
        .project({ id: 1, name: 1, locationIdentifier: 1 })
        .toArray();
      shopMap = shops.reduce((acc, shop) => {
        acc[shop.id] = { name: shop.name, locationIdentifier: shop.locationIdentifier };
        return acc;
      }, {} as Record<number, { name: string; locationIdentifier?: string }>);
    }

    const tickets = rawTickets.map(ticket => ({
      ...ticket,
      shopName: ticket.shopName || (ticket.shopId ? shopMap[ticket.shopId]?.name : null) || null,
      locationIdentifier: ticket.locationIdentifier || (ticket.shopId ? shopMap[ticket.shopId]?.locationIdentifier : null) || null
    }));

    const stats = await db.collection("support_tickets").aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 }
        }
      }
    ]).toArray();

    const statusCounts = {
      open: 0,
      in_progress: 0,
      resolved: 0,
      closed: 0
    };

    stats.forEach(s => {
      if (s._id in statusCounts) {
        statusCounts[s._id as keyof typeof statusCounts] = s.count;
      }
    });

    return NextResponse.json({
      ok: true,
      tickets,
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      stats: statusCounts
    });
  } catch (error: any) {
    console.error("Error fetching tickets:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
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

    const db = await getDb();

    const ticketCount = await db.collection("support_tickets").countDocuments();
    const ticketNumber = `TKT-${String(ticketCount + 1).padStart(5, "0")}`;

    const ticket = {
      ticketNumber,
      subject,
      description,
      category: category || "general",
      priority: priority || "medium",
      status: "open",
      userEmail,
      userName: userName || userEmail.split("@")[0],
      shopId: shopId || null,
      shopName: shopName || null,
      assignedTo: null,
      messages: [{
        id: new ObjectId().toString(),
        from: "user",
        fromEmail: userEmail,
        fromName: userName || userEmail.split("@")[0],
        message: description,
        createdAt: new Date()
      }],
      createdAt: new Date(),
      updatedAt: new Date(),
      resolvedAt: null,
      closedAt: null
    };

    const result = await db.collection("support_tickets").insertOne(ticket);

    return NextResponse.json({
      ok: true,
      ticket: { ...ticket, _id: result.insertedId },
      ticketNumber
    });
  } catch (error: any) {
    console.error("Error creating ticket:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
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

    if (!ObjectId.isValid(ticketId)) {
      return NextResponse.json({ error: "Invalid ticket ID format" }, { status: 400 });
    }

    const db = await getDb();

    const updateFields: Record<string, any> = {
      updatedAt: new Date()
    };

    if (status) {
      updateFields.status = status;
      if (status === "resolved") {
        updateFields.resolvedAt = new Date();
        updateFields.resolvedBy = (await requirePlatformAdmin()).email;
        if (resolutionNotes) {
          updateFields.resolutionNotes = resolutionNotes;
        }
        await clearTicketNotifications(ticketId);
      }
      if (status === "closed") {
        updateFields.closedAt = new Date();
        updateFields.closedBy = (await requirePlatformAdmin()).email;
        if (resolutionNotes) {
          updateFields.resolutionNotes = resolutionNotes;
        }
        await clearTicketNotifications(ticketId);
      }
    }

    if (priority) {
      updateFields.priority = priority;
    }

    if (assignedTo !== undefined) {
      updateFields.assignedTo = assignedTo;
    }

    const updateOps: Record<string, any> = { $set: updateFields };

    if (message) {
      updateOps.$push = {
        messages: {
          id: new ObjectId().toString(),
          from: "admin",
          fromEmail: session.email,
          fromName: session.email.split("@")[0],
          message,
          createdAt: new Date()
        }
      };
    }

    const result = await db.collection("support_tickets").findOneAndUpdate(
      { _id: new ObjectId(ticketId) },
      updateOps,
      { returnDocument: "after" }
    );

    if (!result) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    const ticket = result;
    const statusLabels: Record<string, string> = {
      open: "Open",
      in_progress: "In Progress",
      resolved: "Resolved",
      closed: "Closed"
    };
    const statusLabel = statusLabels[ticket.status] || ticket.status;

    if (ticket.userEmail && (status || message)) {
      try {
        const emailContent = makeTicketUpdatedEmail(
          ticket.ticketNumber,
          ticket.subject,
          statusLabel,
          message || undefined
        );
        await sendEmail({
          to: ticket.userEmail,
          subject: emailContent.subject,
          html: emailContent.html,
          text: emailContent.text,
          shopId: ticket.shopId,
          emailKind: "ticket_updated",
        });
      } catch (emailErr) {
        console.error("Failed to send ticket update email:", emailErr);
      }

      try {
        const shopUser = await db.collection("shop_users").findOne({ email: ticket.userEmail });
        const userId = shopUser?._id?.toString() || ticket.userEmail;
        
        await createNotification({
          userId,
          shopId: ticket.shopId,
          type: status === "resolved" ? "ticket_resolved" : message ? "ticket_message" : "ticket_updated",
          title: status === "resolved" 
            ? `Ticket Resolved: ${ticket.ticketNumber}`
            : message 
              ? `New Reply: ${ticket.ticketNumber}`
              : `Ticket Updated: ${ticket.ticketNumber}`,
          message: message 
            ? message.substring(0, 100) + (message.length > 100 ? "..." : "")
            : `Status changed to ${statusLabel}`,
          link: `/dashboard/support?id=${ticketId}`,
          metadata: { ticketId, ticketNumber: ticket.ticketNumber }
        });
      } catch (notifErr) {
        console.error("Failed to create user notification:", notifErr);
      }
    }

    return NextResponse.json({
      ok: true,
      ticket: result
    });
  } catch (error: any) {
    console.error("Error updating ticket:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to update ticket" }, { status: 500 });
  }
}
