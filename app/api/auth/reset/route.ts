// app/api/auth/reset/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "node:crypto";
import { getDb } from "@/lib/mongo";

/**
 * POST /api/auth/reset
 * Body: { token: string, email: string, password: string }
 *
 * Flow:
 * 1) Validate body.
 * 2) Look up token in password_reset_tokens.
 * 3) Ensure token not used and not expired.
 * 4) Ensure emailLower matches token.emailLower.
 * 5) Hash new password with scrypt (same format used in users.passwordHash).
 * 6) Update users.{passwordHash}, mark token usedAt.
 * 7) Invalidate existing sessions for this user.
 * 8) Create a new session and set HttpOnly cookie so the user is signed in.
 */

export async function POST(req: Request) {
  try {
    const { token, email, password } = await req.json();

    if (!token || !email || !password) {
      return NextResponse.json(
        { ok: false, error: "Email, password, and token are required." },
        { status: 400 }
      );
    }

    const emailLower = String(email).trim().toLowerCase();

    const db = await getDb();
    const pwTokens = db.collection("password_reset_tokens");
    const users = db.collection("users");
    const sessions = db.collection("sessions");

    // 2) Look up token
    const t = await pwTokens.findOne({ token });
    if (!t) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 400 }
      );
    }

    // 3) Validate token timestamps
    const now = new Date();
    if (t.usedAt || (t.expiresAt && new Date(t.expiresAt) < now)) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 400 }
      );
    }

    // 4) Ensure email matches token
    if (t.emailLower !== emailLower) {
      return NextResponse.json(
        { ok: false, error: "Email mismatch for this reset token." },
        { status: 400 }
      );
    }

    // 5) Find user by token’s shopId + emailLower
    const user = await users.findOne(
      { emailLower, shopId: Number(t.shopId) },
      { projection: { _id: 1 } }
    );
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "User not found." },
        { status: 404 }
      );
    }

    const bcrypt = (await import("bcryptjs")).default;
    const passwordHash = await bcrypt.hash(String(password), 12);

    await users.updateOne(
      { _id: user._id },
      { $set: { passwordHash, updatedAt: now }, $unset: { password: "" } }
    );

    // 7) Mark token as used
    await pwTokens.updateOne({ _id: t._id }, { $set: { usedAt: now } });

    await sessions.deleteMany({ userId: user._id });

    const sessionToken = crypto.randomBytes(32).toString("hex");
    const sessionTtlDays = 30;
    const expiresAt = new Date(now.getTime() + sessionTtlDays * 24 * 60 * 60 * 1000);

    await sessions.insertOne({
      token: sessionToken,
      userId: user._id,
      shopId: Number(t.shopId),
      createdAt: now,
      expiresAt,
    });

    const res = NextResponse.json({ ok: true, shopId: Number(t.shopId) });
    res.headers.append(
      "Set-Cookie",
      [
        `session_token=${sessionToken}`,
        `Path=/`,
        `HttpOnly`,
        `Secure`,
        `SameSite=Lax`,
        `Max-Age=${sessionTtlDays * 24 * 60 * 60}`,
      ].join("; ")
    );

    return res;
  } catch (err: any) {
    console.error("Password reset error:", err);
    return NextResponse.json({ ok: false, error: "Server error" }, { status: 500 });
  }
}
