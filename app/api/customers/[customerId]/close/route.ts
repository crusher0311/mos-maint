import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";
import { ObjectId } from "mongodb";

export async function POST(_: Request, { params }: { params: { customerId: string } }) {
  const session = await requireSession();
  const db = await getDb();

  const _id = new ObjectId(params.customerId);
  const shopIdStr = String(session.shopId);
  const now = new Date();

  const res = await db.collection("customers").updateOne(
    { _id, $or: [{ shopId: shopIdStr }, { shopId: Number(shopIdStr) }] },
    { $set: { status: "closed", closedAt: now, updatedAt: now } }
  );

  if (res.matchedCount === 0) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
