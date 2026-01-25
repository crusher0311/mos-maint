import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { sendAnnouncement } from "@/lib/announcements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await sendAnnouncement(params.id);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      stats: result.stats,
    });
  } catch (error) {
    console.error("Error sending announcement:", error);
    return NextResponse.json({ error: "Failed to send announcement" }, { status: 500 });
  }
}
