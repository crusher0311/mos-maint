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

    // 6) Hash new password with scrypt in the same format as existing users.passwordHash
    // Format we produce: "scrypt:1:<saltHex>:<hashHex>"
    async function hashPasswordScrypt(pass: string): Promise<string> {
      const salt = crypto.randomBytes(16);
      // Typical scrypt params; adjust if your existing helper uses different ones.
      const N = 16384, r = 8, p = 1, keylen = 32;
      const derivedKey: Buffer = await new Promise((resolve, reject) => {
        crypto.scrypt(pass, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, dk) => {
          if (err) reject(err);
          else resolve(dk as Buffer);
        });
      });
      return `scrypt:1:${salt.toString("hex")}:${derivedKey.toString("hex")}`;
    }

    const passwordHash = await hashPasswordScrypt(String(password));

    await users.updateOne(
      { _id: user._id },
      { $set: { passwordHash, updatedAt: now }, $unset: { password: "" } }
    );

    // 7) Mark token as used
    await pwTokens.updateOne({ _id: t._id }, { $set: { usedAt: now } });

    // 8) Invalidate existing sessions for this user (optional but recommended)
    await sessions.deleteMany({ userId: user._id });

    // 9) Create new session and set cookie so the user is signed in immediately
    const sessionId = crypto.randomBytes(24).toString("hex");
    const sessionTtlDays = 14; // adjust as needed
    const expiresAt = new Date(now.getTime() + sessionTtlDays * 24 * 60 * 60 * 1000);

    await sessions.insertOne({
      _id: sessionId,
      userId: user._id,
      shopId: Number(t.shopId),
      createdAt: now,
      expiresAt,
    });

    // Set cookie "sid" (align name/options with the rest of your app)
    const res = NextResponse.json({ ok: true, shopId: Number(t.shopId) });
    // SameSite=Lax is typical for session cookies; tweak to your policy.
    res.headers.append(
      "Set-Cookie",
      [
        `sid=${sessionId}`,
        `Path=/`,
        `HttpOnly`,
        `Secure`,
        `SameSite=Lax`,
        `Expires=${expiresAt.toUTCString()}`,
      ].join("; ")
    );

    return res;
  } catch (err: any) {
    console.error("Password reset error:", err);
    return NextResponse.json({ ok: false, error: "Server error" }, { status: 500 });
  }
}
