import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();

  // Find users who have this shop as their primary OR in their additional shopIds
  const users = await db.collection("users")
    .find({ 
      $or: [
        { shopId: sess.shopId },
        { shopIds: sess.shopId },
        { shopIds: String(sess.shopId) },
        { shopIds: Number(sess.shopId) }
      ]
    })
    .project({ passwordHash: 0, password: 0 })
    .sort({ createdAt: -1 })
    .toArray();
  
  // Deduplicate users by email (in case they match multiple conditions)
  const uniqueUsers = Array.from(
    new Map(users.map(u => [u.email.toLowerCase(), u])).values()
  );

  const pendingInvites = await db.collection("setup_tokens")
    .find({ 
      shopId: sess.shopId,
      expiresAt: { $gt: new Date() }
    })
    .sort({ createdAt: -1 })
    .toArray();

  return NextResponse.json({
    users: uniqueUsers,
    pendingInvites,
    currentUserRole: sess.role,
  });
}
