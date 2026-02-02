import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET() {
  try {
    await requirePlatformAdmin();

    const db = await getDb();

    const openCount = await db.collection("support_tickets").countDocuments({
      status: { $in: ["open", "in_progress"] }
    });

    return NextResponse.json({
      ok: true,
      openCount
    });
  } catch (error: any) {
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to get count" }, { status: 500 });
  }
}
