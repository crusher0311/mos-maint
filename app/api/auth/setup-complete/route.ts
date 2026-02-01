import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
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

    let pendingResult = await sql`
      SELECT * FROM pending_signups WHERE pending_id = ${pendingId} LIMIT 1
    `;
    let pending = pendingResult[0];
    
    if (!pending) {
      return NextResponse.json({ error: "Invalid or expired setup link" }, { status: 404 });
    }

    let attempts = 0;
    const maxAttempts = 10;
    
    while (!pending.completed && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000));
      const updatedResult = await sql`
        SELECT * FROM pending_signups WHERE pending_id = ${pendingId} LIMIT 1
      `;
      const updated = updatedResult[0];
      if (updated?.completed) {
        pending = updated;
        break;
      }
      attempts++;
    }

    if (!pending.completed) {
      return NextResponse.json({ 
        error: "Payment is still processing. Please wait a moment and try again." 
      }, { status: 202 });
    }

    const shopId = pending.shop_id || pending.reserved_shop_id;
    const userResult = await sql`
      SELECT id FROM users 
      WHERE LOWER(email) = ${pending.admin_email} AND shop_id = ${String(shopId)}
      LIMIT 1
    `;
    const user = userResult[0];

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const sessionId = crypto.randomBytes(24).toString("hex");
    const now = new Date();
    const ttlDays = 30;
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    
    await sql`
      INSERT INTO sessions (token, user_id, shop_id, created_at, expires_at)
      VALUES (${sessionId}, ${user.id}, ${String(shopId)}, ${now}, ${expiresAt})
    `;

    const res = NextResponse.json({ ok: true, shopId });
    
    res.cookies.set("session_token", sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      expires: expiresAt,
    });
    
    return res;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("Setup complete error:", e);
    return NextResponse.json({ error: message || "Setup failed" }, { status: 500 });
  }
}
