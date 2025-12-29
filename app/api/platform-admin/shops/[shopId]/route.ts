import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = isNaN(Number(params.shopId)) ? params.shopId : Number(params.shopId);
    const { action } = await req.json();

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    if (action === "lock") {
      await db.collection("shops").updateOne(
        { shopId },
        { $set: { isLocked: true, lockedAt: new Date(), lockedBy: session.email } }
      );
      await db.collection("audit_logs").insertOne({
        type: "shop_locked",
        shopId,
        shopName: shop.name,
        adminEmail: session.email,
        createdAt: new Date(),
      });
      return NextResponse.json({ ok: true, message: "Shop locked" });
    }

    if (action === "unlock") {
      await db.collection("shops").updateOne(
        { shopId },
        { $unset: { isLocked: "", lockedAt: "", lockedBy: "" } }
      );
      await db.collection("audit_logs").insertOne({
        type: "shop_unlocked",
        shopId,
        shopName: shop.name,
        adminEmail: session.email,
        createdAt: new Date(),
      });
      return NextResponse.json({ ok: true, message: "Shop unlocked" });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err) {
    console.error("Shop action error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const shopId = isNaN(Number(params.shopId)) ? params.shopId : Number(params.shopId);

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    await db.collection("shops").deleteOne({ shopId });
    await db.collection("users").deleteMany({ shopId });
    await db.collection("sessions").deleteMany({ shopId });

    await db.collection("audit_logs").insertOne({
      type: "shop_deleted",
      shopId,
      shopName: shop.name,
      adminEmail: session.email,
      createdAt: new Date(),
    });

    return NextResponse.json({ ok: true, message: "Shop deleted permanently" });
  } catch (err) {
    console.error("Shop delete error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
