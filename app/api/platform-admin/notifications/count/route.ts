import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function GET() {
  let session;
  try {
    session = await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const userId = `admin:${session.email}`;
    const result = await sql`
      SELECT COUNT(*)::int as count FROM notifications
      WHERE user_id::text = ${userId} AND is_read = false
    `;
    const unreadCount = result[0]?.count ?? 0;

    return NextResponse.json({
      ok: true,
      unreadCount,
    });
  } catch (error) {
    console.error("Error counting admin notifications:", error);
    return NextResponse.json({ ok: false, error: "Failed to count" }, { status: 500 });
  }
}
