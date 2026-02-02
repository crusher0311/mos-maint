import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export async function GET(
  request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    await requirePlatformAdmin();

    const { ticketId } = params;

    if (!ticketId || !ObjectId.isValid(ticketId)) {
      return NextResponse.json({ error: "Invalid ticket ID" }, { status: 400 });
    }

    const db = await getDb();

    const ticket = await db.collection("support_tickets").findOne({
      _id: new ObjectId(ticketId)
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
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
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

    if (!ticketId || !ObjectId.isValid(ticketId)) {
      return NextResponse.json({ error: "Invalid ticket ID" }, { status: 400 });
    }

    const db = await getDb();

    const result = await db.collection("support_tickets").deleteOne({
      _id: new ObjectId(ticketId)
    });

    if (result.deletedCount === 0) {
      return NextResponse.json({ error: "Ticket not found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      message: "Ticket deleted"
    });
  } catch (error: any) {
    console.error("Error deleting ticket:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to delete ticket" }, { status: 500 });
  }
}
