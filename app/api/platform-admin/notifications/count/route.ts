import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET() {
  let session;
  try {
    session = await requirePlatformAdmin();
  } catch {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = await getDb();
    const unreadCount = await db.collection("notifications").countDocuments({
      userId: `admin:${session.email}`,
      read: false,
    });

    return NextResponse.json({
      ok: true,
      unreadCount,
    });
  } catch (error) {
    console.error("Error counting admin notifications:", error);
    return NextResponse.json({ ok: false, error: "Failed to count" }, { status: 500 });
  }
}
