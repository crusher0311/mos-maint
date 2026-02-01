import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function GET(
  request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    await requirePlatformAdmin();

    const { ticketId } = params;
    const numTicketId = Number(ticketId);

    if (!ticketId || isNaN(numTicketId)) {
      return NextResponse.json({ error: "Invalid ticket ID" }, { status: 400 });
    }

    const result = await sql`
      SELECT * FROM support_tickets WHERE id = ${numTicketId}
    `;

    if (result.length === 0) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

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
        assignedTo: ticket.assigned_to,
        messages: ticket.messages || [],
        createdAt: ticket.created_at,
        updatedAt: ticket.updated_at,
        resolvedAt: ticket.resolved_at,
        closedAt: ticket.closed_at,
        resolutionNotes: ticket.resolution_notes,
      }
    });
  } catch (error: unknown) {
    console.error("Error fetching ticket:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch ticket" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    await requirePlatformAdmin();

    const { ticketId } = params;
    const numTicketId = Number(ticketId);

    if (!ticketId || isNaN(numTicketId)) {
      return NextResponse.json({ error: "Invalid ticket ID" }, { status: 400 });
    }

    const result = await sql`
      DELETE FROM support_tickets WHERE id = ${numTicketId}
    `;

    if (result.count === 0) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      message: "Ticket deleted"
    });
  } catch (error: unknown) {
    console.error("Error deleting ticket:", error);
    const errMsg = error instanceof Error ? error.message : "Unknown error";
    if (errMsg === "Unauthorized" || errMsg === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to delete ticket" }, { status: 500 });
  }
}
