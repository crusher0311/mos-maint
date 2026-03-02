import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
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

    const db = await getDb();
    const user = await db.collection("users").findOne({
      email: email.toLowerCase().trim(),
    });

    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Invalid credentials" },
        { status: 401 }
      );
    }

    if (!user.isPlatformAdmin) {
      return NextResponse.json(
        { ok: false, error: "Access denied. Platform admin privileges required." },
        { status: 403 }
      );
    }

    let valid = false;
    const dbHash = user.passwordHash;
    const legacyPlain = user.password;

    if (dbHash && dbHash.startsWith("$2")) {
      valid = await bcrypt.compare(password, dbHash);
    } else if (legacyPlain) {
      if (legacyPlain.startsWith("$2")) {
        valid = await bcrypt.compare(password, legacyPlain);
      } else {
        valid = legacyPlain === password;
      }
      if (valid) {
        const hashed = await bcrypt.hash(password, 12);
        await db.collection("users").updateOne(
          { _id: user._id },
          { $set: { passwordHash: hashed }, $unset: { password: "" } }
        );
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

    await db.collection("sessions").insertOne({
      token,
      userId: user._id,
      shopId: user.shopId,
      email: user.email,
      isPlatformAdmin: true,
      createdAt: new Date(),
      expiresAt,
    });

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
