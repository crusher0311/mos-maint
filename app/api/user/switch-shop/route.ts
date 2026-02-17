import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import { getSession, sessionCookieOptions } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { shopId } = await req.json();
    if (typeof shopId !== "number") {
      return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
    }

    const db = await getDb();

    let userInShop = await db.collection("users").findOne({
      email: session.email.toLowerCase(),
      shopId: shopId,
    });

    if (!userInShop) {
      const primaryUser = await db.collection("users").findOne({
        email: session.email.toLowerCase(),
        shopIds: { $in: [shopId, String(shopId)] },
      });
      if (primaryUser) {
        userInShop = primaryUser;
      }
    }

    if (!userInShop) {
      return NextResponse.json(
        { error: "You don't have access to this shop" },
        { status: 403 }
      );
    }

    const newToken = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

    await db.collection("sessions").insertOne({
      token: newToken,
      userId: userInShop._id,
      shopId: shopId,
      createdAt: new Date(),
      expiresAt,
    });

    const store = await cookies();
    store.set("session_token", newToken, sessionCookieOptions(60 * 60 * 24 * 30));

    const shop = await db.collection("shops").findOne({ shopId });
    const shopName = shop?.name || `Shop ${shopId}`;

    return NextResponse.json({
      ok: true,
      shopId,
      shopName,
    });
  } catch (err) {
    console.error("Error switching shop:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
