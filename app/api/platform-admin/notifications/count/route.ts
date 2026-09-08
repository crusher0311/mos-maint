import { NextResponse } from "next/server";
import { __deps } from "./deps";

export async function GET() {
  try {
    await __deps.requirePlatformAdmin();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const unreadCount = await __deps.getAdminUnreadCount();

    return NextResponse.json({
      ok: true,
      unreadCount,
    });
  } catch (error) {
    console.error("Error counting admin notifications:", error);
    return NextResponse.json({ ok: false, error: "Failed to count" }, { status: 500 });
  }
}
