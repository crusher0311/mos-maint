import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import sql from "@/lib/db/postgres";
import { sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";

function looksLikeBcrypt(s: unknown) {
  return typeof s === "string" && /^\$2[aby]\$/.test(s);
}

function looksLikeScrypt(s: unknown) {
  return typeof s === "string" && s.startsWith("scrypt:");
}

async function verifyScrypt(password: string, hash: string): Promise<boolean> {
  const parts = hash.split(":");
  if (parts.length < 4) return false;
  const salt = parts[2];
  const storedDerived = parts[3];
  const crypto = await import("crypto");
  return new Promise((resolve) => {
    crypto.scrypt(password, salt, 64, (err, buf) => {
      if (err) return resolve(false);
      resolve(buf.toString("hex") === storedDerived);
    });
  });
}

export async function POST(req: Request) {
  try {
    const { email, password, shopId } = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    const emailLower = String(email).toLowerCase();

    let candidates;
    if (shopId !== undefined && shopId !== null && String(shopId).trim() !== "") {
      candidates = await sql`
        SELECT id, email, role, password_hash, password, shop_id 
        FROM users 
        WHERE email = ${emailLower} AND shop_id = ${String(shopId)}
      `;
    } else {
      candidates = await sql`
        SELECT id, email, role, password_hash, password, shop_id 
        FROM users 
        WHERE email = ${emailLower}
      `;
    }

    if (candidates.length === 0) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const user = candidates[0];
    const dbHash = user.password_hash;
    const legacyPlain = user.password;

    let passOk = false;

    if (looksLikeBcrypt(dbHash)) {
      passOk = await bcrypt.compare(String(password), String(dbHash));
    } else if (looksLikeScrypt(dbHash)) {
      passOk = await verifyScrypt(String(password), String(dbHash));
      if (passOk) {
        const newHash = await bcrypt.hash(String(password), 12);
        await sql`UPDATE users SET password_hash = ${newHash} WHERE id = ${user.id}`;
      }
    } else if (legacyPlain) {
      passOk = String(password) === String(legacyPlain);
      if (passOk) {
        const newHash = await bcrypt.hash(String(password), 12);
        await sql`UPDATE users SET password_hash = ${newHash}, password = NULL WHERE id = ${user.id}`;
      }
    }

    if (!passOk) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

    await sql`
      INSERT INTO sessions (token, user_id, shop_id, created_at, expires_at)
      VALUES (${token}, ${user.id}, ${user.shop_id || shopId || '0'}, ${new Date()}, ${expiresAt})
    `;

    const store = await cookies();
    store.set(
      "session_token",
      token,
      sessionCookieOptions(60 * 60 * 24 * 30)
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Login error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
