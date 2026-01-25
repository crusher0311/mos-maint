import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getActiveAnnouncements } from "@/lib/announcements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ announcements: [] });
    }

    const announcements = await getActiveAnnouncements(session.userId);

    return NextResponse.json({ announcements });
  } catch (error) {
    console.error("Error fetching active announcements:", error);
    return NextResponse.json({ announcements: [] });
  }
}
