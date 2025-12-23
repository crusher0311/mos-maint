import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { userId } = params;

  const db = await getDb();
  const users = db.collection("users");

  const user = await users.findOne({ _id: new ObjectId(userId) });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const userShopId = String(user.shopId);
  const sessionShopId = String(sess.shopId);

  if (userShopId !== sessionShopId && sess.role !== "admin") {
    return NextResponse.json({ error: "Cannot remove user from another shop" }, { status: 403 });
  }

  if (user.role === "owner") {
    return NextResponse.json({ error: "Cannot remove shop owner" }, { status: 400 });
  }

  await users.deleteOne({ _id: new ObjectId(userId), shopId: user.shopId });

  return NextResponse.json({ ok: true });
}
