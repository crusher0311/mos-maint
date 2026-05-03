import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { updateCustomerById } from "@/lib/data/repositories/customers";

export async function POST(_: Request, { params }: { params: { customerId: string } }) {
  const session = await requireSession();
  const shopIdStr = String(session.shopId);
  const now = new Date();

  const res = await updateCustomerById(
    params.customerId,
    { $or: [{ shopId: shopIdStr }, { shopId: Number(shopIdStr) }] },
    { $set: { status: "closed", closedAt: now, updatedAt: now } },
  );

  if (res.matchedCount === 0) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
