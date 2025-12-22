import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = { shopId: String(session.shopId) };

    const db = await getDb();
    const shop = await db.collection("shops").findOne({ _id: user.shopId });

    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const autovitals = shop.autovitals || {};

    return NextResponse.json({
      shopId: autovitals.shopId || null,
      userId: autovitals.userId || null,
      sessionCookie: autovitals.sessionCookie ? "••••••••" : "",
      jwtToken: autovitals.jwtToken ? "••••••••" : "",
      isConfigured: !!(autovitals.shopId && autovitals.sessionCookie),
    });
  } catch (error) {
    console.error("[AutoVitals Settings GET] Error:", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const user = { shopId: String(session.shopId) };

    const body = await request.json();
    const { shopId, userId, sessionCookie, jwtToken } = body;

    if (!shopId) {
      return NextResponse.json({ error: "Shop ID is required" }, { status: 400 });
    }

    if (!sessionCookie || sessionCookie === "••••••••") {
      const db = await getDb();
      const shop = await db.collection("shops").findOne({ _id: user.shopId });
      if (!shop?.autovitals?.sessionCookie) {
        return NextResponse.json({ error: "Session Cookie is required" }, { status: 400 });
      }
    }

    const db = await getDb();
    
    const updateData: Record<string, any> = {
      "autovitals.shopId": shopId,
      "autovitals.updatedAt": new Date(),
    };

    if (userId) {
      updateData["autovitals.userId"] = userId;
    }

    if (sessionCookie && sessionCookie !== "••••••••") {
      updateData["autovitals.sessionCookie"] = sessionCookie;
    }

    if (jwtToken && jwtToken !== "••••••••") {
      updateData["autovitals.jwtToken"] = jwtToken;
    }

    await db.collection("shops").updateOne(
      { _id: user.shopId },
      { $set: updateData }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[AutoVitals Settings POST] Error:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
