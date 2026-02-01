import { NextRequest, NextResponse } from "next/server";
import { sessionCookieOptions } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const shopId = String(body?.shopId);
    const token = String(body?.token || "");
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");

    if (!shopId || !token || !email || !password) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const now = new Date();
    const inviteResult = await sql`
      SELECT * FROM setup_tokens 
      WHERE token = ${token} AND shop_id = ${shopId} AND expires_at > ${now}
      LIMIT 1
    `;
    const invite = inviteResult[0];

    if (!invite) {
      return NextResponse.json({ error: "Invalid or expired setup token" }, { status: 401 });
    }

    const inviteEmail = (invite.email_lower || "").toLowerCase();
    if (inviteEmail && inviteEmail !== email) {
      return NextResponse.json({ error: "Email does not match invite" }, { status: 403 });
    }

    const role = invite.role || "user";

    const existsResult = await sql`
      SELECT id FROM users WHERE shop_id = ${shopId} AND LOWER(email) = ${email} LIMIT 1
    `;
    if (existsResult.length > 0) {
      return NextResponse.json({ error: "User already exists for this shop" }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const userResult = await sql`
      INSERT INTO users (shop_id, email, role, password_hash, created_at, updated_at)
      VALUES (${shopId}, ${email}, ${role}, ${passwordHash}, ${now}, ${now})
      RETURNING id
    `;
    const userId = userResult[0].id;

    await sql`DELETE FROM setup_tokens WHERE id = ${invite.id}`;

    const sessionToken = crypto.randomBytes(32).toString("hex");
    const ttlDays = 30;
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

    await sql`
      INSERT INTO sessions (token, user_id, shop_id, created_at, expires_at)
      VALUES (${sessionToken}, ${userId}, ${shopId}, ${now}, ${expiresAt})
    `;

    const res = NextResponse.json({ ok: true, redirect: "/dashboard", shopId, role });
    res.cookies.set("session_token", sessionToken, sessionCookieOptions(ttlDays * 24 * 60 * 60));
    return res;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("Complete setup error:", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
