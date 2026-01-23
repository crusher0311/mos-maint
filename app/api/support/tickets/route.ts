import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export async function GET(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();

    const tickets = await db.collection("support_tickets")
      .find({ userEmail: user.email })
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
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { subject, description, category, priority } = body;

    if (!subject || !description) {
      return NextResponse.json({ error: "Subject and description are required" }, { status: 400 });
    }

    const db = await getDb();

    const shopInfo = await db.collection("shop_users").findOne({ email: user.email });

    const ticketCount = await db.collection("support_tickets").countDocuments();
    const ticketNumber = `TKT-${String(ticketCount + 1).padStart(5, "0")}`;

    const ticket = {
      ticketNumber,
      subject,
      description,
      category: category || "general",
      priority: priority || "medium",
      status: "open",
      userEmail: user.email,
      userName: user.name || user.email.split("@")[0],
      shopId: shopInfo?.shopId || null,
      shopName: shopInfo?.shopName || null,
      assignedTo: null,
      messages: [{
        id: new ObjectId().toString(),
        from: "user",
        fromEmail: user.email,
        fromName: user.name || user.email.split("@")[0],
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
    return NextResponse.json({ error: "Failed to create ticket" }, { status: 500 });
  }
}
