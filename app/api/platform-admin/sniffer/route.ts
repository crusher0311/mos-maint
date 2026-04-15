import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db/drizzle";
import { snifferSessions } from "@/lib/db/schema/sniffer";
import { desc, eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json(
      { error: "Platform admin access required" },
      { status: 403 }
    );
  }

  const db = getDb();
  const sessions = await db
    .select({
      id: snifferSessions.id,
      uploadedBy: snifferSessions.uploadedBy,
      uploadedByEmail: snifferSessions.uploadedByEmail,
      platform: snifferSessions.platform,
      label: snifferSessions.label,
      captureCount: snifferSessions.captureCount,
      createdAt: snifferSessions.createdAt,
    })
    .from(snifferSessions)
    .orderBy(desc(snifferSessions.createdAt))
    .limit(100);

  return NextResponse.json({ sessions });
}
