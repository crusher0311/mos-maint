import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();

  const users = await db.collection("users")
    .find({ shopId: sess.shopId })
    .project({ passwordHash: 0, password: 0 })
    .sort({ createdAt: -1 })
    .toArray();

  const pendingInvites = await db.collection("setup_tokens")
    .find({ 
      shopId: sess.shopId,
      expiresAt: { $gt: new Date() }
    })
    .sort({ createdAt: -1 })
    .toArray();

  return NextResponse.json({
    users,
    pendingInvites,
    currentUserRole: sess.role,
  });
}
