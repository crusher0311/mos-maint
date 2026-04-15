import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db/drizzle";
import { snifferSessions } from "@/lib/db/schema/sniffer";
import { eq } from "drizzle-orm";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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

  const id = parseInt(params.id);
  if (isNaN(id)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  const offset = parseInt(request.nextUrl.searchParams.get("offset") || "0");
  const limit = Math.min(
    parseInt(request.nextUrl.searchParams.get("limit") || "50"),
    200
  );

  const db = getDb();
  const [result] = await db
    .select()
    .from(snifferSessions)
    .where(eq(snifferSessions.id, id))
    .limit(1);

  if (!result) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const allCaptures = (result.captures as any[]) || [];
  const paginatedCaptures = allCaptures.slice(offset, offset + limit);

  return NextResponse.json({
    session: {
      id: result.id,
      uploadedBy: result.uploadedBy,
      uploadedByEmail: result.uploadedByEmail,
      platform: result.platform,
      label: result.label,
      captureCount: result.captureCount,
      createdAt: result.createdAt,
      captures: paginatedCaptures,
      totalCaptures: allCaptures.length,
      offset,
      limit,
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
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

  const id = parseInt(params.id);
  if (isNaN(id)) {
    return NextResponse.json({ error: "Invalid session ID" }, { status: 400 });
  }

  const db = getDb();
  await db.delete(snifferSessions).where(eq(snifferSessions.id, id));

  return NextResponse.json({ success: true });
}
