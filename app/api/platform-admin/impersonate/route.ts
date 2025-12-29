import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import { getSession, sessionCookieOptions } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session || !session.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { shopId: rawShopId } = await req.json();

    const shopId = typeof rawShopId === "string" && !isNaN(Number(rawShopId)) 
      ? Number(rawShopId) 
      : rawShopId;

    if (shopId === undefined || shopId === null) {
      return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
    }

    const db = await getDb();

    const shop = await db.collection("shops").findOne({ shopId });
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    if (shop.isLocked) {
      return NextResponse.json({ error: "Shop is locked. Unlock it first to access." }, { status: 403 });
    }

    let targetUser = await db.collection("users").findOne({
      shopId,
      role: "owner",
    });

    if (!targetUser) {
      targetUser = await db.collection("users").findOne({ shopId });
    }

    if (!targetUser) {
      return NextResponse.json({ error: "No users found for this shop" }, { status: 404 });
    }

    const newToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 4); // 4 hours for impersonation

    await db.collection("sessions").insertOne({
      token: newToken,
      userId: targetUser._id,
      shopId,
      createdAt: new Date(),
      expiresAt,
      impersonatedBy: session.email,
      isImpersonation: true,
    });

    await db.collection("audit_logs").insertOne({
      type: "impersonation",
      adminEmail: session.email,
      targetShopId: shopId,
      targetShopName: shop.name,
      targetUserEmail: targetUser.email,
      createdAt: new Date(),
    });

    const store = await cookies();
    store.set("session_token", newToken, sessionCookieOptions(60 * 60 * 4));

    return NextResponse.json({
      ok: true,
      shopId,
      shopName: shop.name || `Shop ${shopId}`,
      userEmail: targetUser.email,
    });
  } catch (err) {
    console.error("Error impersonating shop:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
