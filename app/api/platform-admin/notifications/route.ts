import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { markAllAsRead } from "@/lib/notifications";

export async function GET(req: NextRequest) {
  let session;
  try {
    session = await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get("limit") || "20");
  const unreadOnly = searchParams.get("unreadOnly") === "true";

  try {
    const db = await getDb();
    const query: any = { userId: `admin:${session.email}` };
    if (unreadOnly) {
      query.read = false;
    }
    
    const notifications = await db.collection("notifications")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    
    const unreadCount = await db.collection("notifications").countDocuments({
      userId: `admin:${session.email}`,
      read: false,
    });

    return NextResponse.json({
      ok: true,
      notifications,
      unreadCount,
    });
  } catch (error) {
    console.error("Error fetching admin notifications:", error);
    return NextResponse.json({ ok: false, error: "Failed to fetch notifications" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  
  if (body.action === "markAllRead") {
    const count = await markAllAsRead(`admin:${session.email}`);
    return NextResponse.json({ ok: true, markedCount: count });
  }

  return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
}
