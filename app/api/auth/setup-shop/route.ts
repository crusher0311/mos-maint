import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { shopName, newPassword } = body;

  if (!shopName || typeof shopName !== "string" || shopName.trim().length < 2) {
    return NextResponse.json(
      { error: "Shop name is required (at least 2 characters)" },
      { status: 400 }
    );
  }

  const db = await getDb();

  const shop = await db.collection("shops").findOne({ shopId: sess.shopId });
  if (!shop?.provisionedVia || shop?.setupCompleted) {
    return NextResponse.json(
      { error: "Setup is not required for this account" },
      { status: 403 }
    );
  }

  const sanitizedName = shopName.trim().slice(0, 200);

  await db.collection("shops").updateOne(
    { shopId: sess.shopId },
    {
      $set: {
        name: sanitizedName,
        setupCompleted: true,
        updatedAt: new Date(),
      },
    }
  );

  const userUpdate: Record<string, any> = {
    mustChangePassword: false,
    updatedAt: new Date(),
  };

  if (newPassword && typeof newPassword === "string" && newPassword.length >= 8) {
    userUpdate.passwordHash = await bcrypt.hash(newPassword, 12);
  }

  await db.collection("users").updateOne(
    { email: sess.email, shopId: sess.shopId },
    { $set: userUpdate }
  );

  return NextResponse.json({
    success: true,
    shopName: sanitizedName,
  });
}
