import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUnreadCount } from "@/lib/notifications";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.email;
  const unreadCount = await getUnreadCount(userId);

  return NextResponse.json({
    ok: true,
    unreadCount,
  });
}
