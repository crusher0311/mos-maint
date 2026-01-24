import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const pendingId = String(body?.pendingId || "").trim();

    if (!pendingId) {
      return NextResponse.json({ error: "Missing pending ID" }, { status: 400 });
    }

    const db = await getDb();
    
    const pending = await db.collection("pending_signups").findOne({ pendingId });
    
    if (!pending) {
      return NextResponse.json({ error: "Invalid or expired setup link" }, { status: 404 });
    }

    let attempts = 0;
    const maxAttempts = 10;
    
    while (!pending.completed && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000));
      const updated = await db.collection("pending_signups").findOne({ pendingId });
      if (updated?.completed) {
        Object.assign(pending, updated);
        break;
      }
      attempts++;
    }

    if (!pending.completed) {
      return NextResponse.json({ 
        error: "Payment is still processing. Please wait a moment and try again." 
      }, { status: 202 });
    }

    const shopId = pending.shopId || pending.reservedShopId;
    const user = await db.collection("users").findOne({ 
      emailLower: pending.adminEmail,
      shopId 
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const sessionId = crypto.randomBytes(24).toString("hex");
    const now = new Date();
    const ttlDays = 30;
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    
    await db.collection("sessions").insertOne({
      token: sessionId,
      userId: user._id,
      shopId,
      createdAt: now,
      expiresAt,
    });

    const res = NextResponse.json({ ok: true, shopId });
    
    res.cookies.set("session_token", sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    });
    
    return res;
  } catch (e: any) {
    console.error("Setup complete error:", e);
    return NextResponse.json({ error: e?.message || "Setup failed" }, { status: 500 });
  }
}
