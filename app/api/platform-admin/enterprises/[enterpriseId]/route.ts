import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { enterpriseId: string } }
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { action, shopId } = await req.json();
    const enterpriseId = params.enterpriseId;

    const db = await getDb();
    const enterprise = await db.collection("enterprise_accounts").findOne({ 
      _id: new ObjectId(enterpriseId) 
    });

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    if (action === "add_shop" && shopId) {
      await db.collection("enterprise_accounts").updateOne(
        { _id: new ObjectId(enterpriseId) },
        { $addToSet: { shopIds: shopId }, $set: { updatedAt: new Date() } }
      );

      await db.collection("shops").updateOne(
        { shopId },
        { $set: { enterpriseId: new ObjectId(enterpriseId), updatedAt: new Date() } }
      );

      await db.collection("audit_logs").insertOne({
        type: "enterprise_shop_added",
        enterpriseId: new ObjectId(enterpriseId),
        enterpriseName: enterprise.name,
        shopId,
        adminEmail: session.email,
        createdAt: new Date(),
      });

      return NextResponse.json({ ok: true, message: "Shop added to enterprise" });
    }

    if (action === "remove_shop" && shopId) {
      await db.collection("enterprise_accounts").updateOne(
        { _id: new ObjectId(enterpriseId) },
        { $pull: { shopIds: shopId }, $set: { updatedAt: new Date() } }
      );

      await db.collection("shops").updateOne(
        { shopId },
        { $unset: { enterpriseId: "" }, $set: { updatedAt: new Date() } }
      );

      await db.collection("audit_logs").insertOne({
        type: "enterprise_shop_removed",
        enterpriseId: new ObjectId(enterpriseId),
        enterpriseName: enterprise.name,
        shopId,
        adminEmail: session.email,
        createdAt: new Date(),
      });

      return NextResponse.json({ ok: true, message: "Shop removed from enterprise" });
    }

    if (action === "rename" && req.body) {
      const body = await req.json().catch(() => ({}));
      const newName = body.name;
      if (newName?.trim()) {
        await db.collection("enterprise_accounts").updateOne(
          { _id: new ObjectId(enterpriseId) },
          { $set: { name: newName.trim(), updatedAt: new Date() } }
        );
        return NextResponse.json({ ok: true, message: "Enterprise renamed" });
      }
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: any) {
    console.error("Enterprise action error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { enterpriseId: string } }
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const enterpriseId = params.enterpriseId;
    const db = await getDb();

    const enterprise = await db.collection("enterprise_accounts").findOne({
      _id: new ObjectId(enterpriseId)
    });

    if (!enterprise) {
      return NextResponse.json({ error: "Enterprise not found" }, { status: 404 });
    }

    await db.collection("shops").updateMany(
      { enterpriseId: new ObjectId(enterpriseId) },
      { $unset: { enterpriseId: "" }, $set: { updatedAt: new Date() } }
    );

    await db.collection("enterprise_accounts").deleteOne({
      _id: new ObjectId(enterpriseId)
    });

    await db.collection("audit_logs").insertOne({
      type: "enterprise_deleted",
      enterpriseId: new ObjectId(enterpriseId),
      enterpriseName: enterprise.name,
      adminEmail: session.email,
      createdAt: new Date(),
    });

    return NextResponse.json({ ok: true, message: "Enterprise deleted" });
  } catch (err: any) {
    console.error("Delete enterprise error:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}
