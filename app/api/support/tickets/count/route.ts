import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();

    const openCount = await db.collection("support_tickets").countDocuments({
      userEmail: user.email,
      status: { $in: ["open", "in_progress"] }
    });

    return NextResponse.json({
      ok: true,
      openCount
    });
  } catch (error: any) {
    return NextResponse.json({ error: "Failed to get count" }, { status: 500 });
  }
}
