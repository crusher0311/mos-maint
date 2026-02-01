import { NextResponse } from "next/server";
import crypto from "node:crypto";
import sql from "@/lib/db/postgres";

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

    const tokenResult = await sql`
      SELECT * FROM password_reset_tokens WHERE token = ${token} LIMIT 1
    `;
    const t = tokenResult[0];

    if (!t) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 400 }
      );
    }

    const now = new Date();
    if (t.used_at || (t.expires_at && new Date(t.expires_at) < now)) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired token." },
        { status: 400 }
      );
    }

    if (t.email_lower !== emailLower) {
      return NextResponse.json(
        { ok: false, error: "Email mismatch for this reset token." },
        { status: 400 }
      );
    }

    const userResult = await sql`
      SELECT id FROM users 
      WHERE LOWER(email) = ${emailLower} AND shop_id = ${t.shop_id}
      LIMIT 1
    `;
    const user = userResult[0];

    if (!user) {
      return NextResponse.json(
        { ok: false, error: "User not found." },
        { status: 404 }
      );
    }

    async function hashPasswordScrypt(pass: string): Promise<string> {
      const salt = crypto.randomBytes(16);
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

    await sql`
      UPDATE users SET password_hash = ${passwordHash}, password = NULL, updated_at = ${now}
      WHERE id = ${user.id}
    `;

    await sql`
      UPDATE password_reset_tokens SET used_at = ${now} WHERE id = ${t.id}
    `;

    await sql`DELETE FROM sessions WHERE user_id = ${user.id}`;

    const sessionId = crypto.randomBytes(24).toString("hex");
    const sessionTtlDays = 14;
    const expiresAt = new Date(now.getTime() + sessionTtlDays * 24 * 60 * 60 * 1000);

    await sql`
      INSERT INTO sessions (token, user_id, shop_id, created_at, expires_at)
      VALUES (${sessionId}, ${user.id}, ${t.shop_id}, ${now}, ${expiresAt})
    `;

    const res = NextResponse.json({ ok: true, shopId: parseInt(t.shop_id, 10) });
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
  } catch (err: unknown) {
    console.error("Password reset error:", err);
    return NextResponse.json({ ok: false, error: "Server error" }, { status: 500 });
  }
}
