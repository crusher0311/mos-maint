import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { inviteId: string } }
) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { inviteId } = params;

  const db = await getDb();
  const invites = db.collection("setup_tokens");

  const invite = await invites.findOne({ _id: new ObjectId(inviteId) });
  if (!invite) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }

  if (invite.shopId !== sess.shopId && sess.role !== "admin") {
    return NextResponse.json({ error: "Cannot cancel invite from another shop" }, { status: 403 });
  }

  await invites.deleteOne({ _id: new ObjectId(inviteId) });

  return NextResponse.json({ ok: true });
}
