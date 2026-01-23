import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { markSessionResolved, getSessionById } from "@/lib/support-chat";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { sessionId } = body;

  if (!sessionId) {
    return NextResponse.json({ ok: false, error: "Session ID is required" }, { status: 400 });
  }

  const chatSession = await getSessionById(sessionId);
  if (!chatSession || chatSession.userEmail !== session.email) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }

  await markSessionResolved(sessionId);

  return NextResponse.json({ ok: true });
}
