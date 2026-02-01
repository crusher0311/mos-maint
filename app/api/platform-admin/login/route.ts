import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import bcrypt from "bcryptjs";
import crypto from "crypto";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, password } = body;

    if (!email || !password) {
      return NextResponse.json(
        { ok: false, error: "Email and password are required" },
        { status: 400 }
      );
    }

    const userRows = await sql`
      SELECT * FROM users WHERE LOWER(email) = LOWER(${email.trim()})
    `;
    const user = userRows[0] as any;

    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Invalid credentials" },
        { status: 401 }
      );
    }

    if (!user.is_platform_admin) {
      return NextResponse.json(
        { ok: false, error: "Access denied. Platform admin privileges required." },
        { status: 403 }
      );
    }

    let valid = false;
    if (user.password) {
      if (user.password.startsWith("$2")) {
        valid = await bcrypt.compare(password, user.password);
      } else {
        valid = user.password === password;
        if (valid) {
          const hashed = await bcrypt.hash(password, 12);
          await sql`UPDATE users SET password = ${hashed} WHERE id = ${user.id}`;
        }
      }
    }

    if (!valid) {
      return NextResponse.json(
        { ok: false, error: "Invalid credentials" },
        { status: 401 }
      );
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await sql`
      INSERT INTO sessions (token, user_id, shop_id, email, is_platform_admin, created_at, expires_at)
      VALUES (${token}, ${user.id}, ${user.shop_id}, ${user.email}, true, NOW(), ${expiresAt})
    `;

    const store = await cookies();
    store.set(SESSION_COOKIE, token, sessionCookieOptions());

    return NextResponse.json({
      ok: true,
      message: "Login successful",
      redirect: "/platform-admin",
    });
  } catch (error) {
    console.error("Platform admin login error:", error);
    return NextResponse.json(
      { ok: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
