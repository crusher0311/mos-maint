import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUserNotifications, markAllAsRead, getUnreadCount } from "@/lib/notifications";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get("limit") || "20");
  const unreadOnly = searchParams.get("unreadOnly") === "true";

  const userId = session.email;
  const notifications = await getUserNotifications(userId, limit, unreadOnly);
  const unreadCount = await getUnreadCount(userId);

  return NextResponse.json({
    ok: true,
    notifications,
    unreadCount,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  
  if (body.action === "markAllRead") {
    const userId = session.email;
    const count = await markAllAsRead(userId);
    return NextResponse.json({ ok: true, markedCount: count });
  }

  return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
}
