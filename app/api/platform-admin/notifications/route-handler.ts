import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  getAdminUnreadCount,
  getPlatformAdminNotifications,
  getPlatformAdminUnreadNotifications,
  markAllPlatformAdminNotificationsRead,
} from "@/lib/notifications";

export const __deps = {
  requirePlatformAdmin,
  getAdminUnreadCount,
  getPlatformAdminNotifications,
  getPlatformAdminUnreadNotifications,
  markAllPlatformAdminNotificationsRead,
};

export async function GET(req: NextRequest) {
  try {
    await __deps.requirePlatformAdmin();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const requestedLimit = Number(searchParams.get("limit") || "20");
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 20;
  const unreadOnly = searchParams.get("unreadOnly") === "true";

  try {
    const notifications = unreadOnly
      ? await __deps.getPlatformAdminUnreadNotifications(limit)
      : await __deps.getPlatformAdminNotifications(limit);
    const unreadCount = await __deps.getAdminUnreadCount();

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
  try {
    await __deps.requirePlatformAdmin();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  
  if (body && typeof body === "object" && "action" in body && body.action === "markAllRead") {
    const count = await __deps.markAllPlatformAdminNotificationsRead();
    return NextResponse.json({ ok: true, markedCount: count });
  }

  return NextResponse.json({ ok: false, error: "Invalid action" }, { status: 400 });
}
