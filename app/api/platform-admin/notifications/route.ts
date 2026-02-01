import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";
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
    const userId = `admin:${session.email}`;
    
    let notifications;
    if (unreadOnly) {
      notifications = await sql`
        SELECT * FROM notifications 
        WHERE user_id = ${userId} AND read = false
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else {
      notifications = await sql`
        SELECT * FROM notifications 
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    }
    
    const countResult = await sql`
      SELECT COUNT(*)::int as count FROM notifications
      WHERE user_id = ${userId} AND read = false
    `;
    const unreadCount = countResult[0]?.count ?? 0;

    return NextResponse.json({
      ok: true,
      notifications: notifications.map((n: any) => ({
        _id: n.id,
        userId: n.user_id,
        type: n.type,
        title: n.title,
        message: n.message,
        read: n.read,
        data: n.data,
        createdAt: n.created_at,
      })),
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
