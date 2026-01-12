import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  
  if (!token) {
    return NextResponse.json({ error: "Token required" }, { status: 400 });
  }

  const db = await getDb();
  const resetToken = await db.collection("password_reset_tokens").findOne({
    token,
    expiresAt: { $gt: new Date() },
  });

  if (!resetToken) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
