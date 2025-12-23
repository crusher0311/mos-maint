// app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { getDb } from "@/lib/mongo";
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

    const db = await getDb();

    // Find by email (+ optional shop)
    const query: any = { email: String(email).toLowerCase() };
    if (shopId !== undefined && shopId !== null && String(shopId).trim() !== "") {
      query.shopId = Number(shopId);
    }

    // Handle duplicate emails across shops more clearly
    const candidates = await db
      .collection("users")
      .find(query.shopId ? query : { email: query.email })
      .project({ _id: 1, email: 1, role: 1, passwordHash: 1, password: 1, shopId: 1 })
      .toArray();

    if (candidates.length === 0) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }
    if (!query.shopId && candidates.length > 1) {
      return NextResponse.json(
        { error: "Multiple shops found for this email. Please enter your Shop ID." },
        { status: 400 }
      );
    }

    const user = candidates[0];

    // Password checks with graceful migration
    const dbHash = user.passwordHash;
    const legacyPlain = user.password; // legacy field (plaintext or other)

    let passOk = false;

    if (looksLikeBcrypt(dbHash)) {
      passOk = await bcrypt.compare(String(password), String(dbHash));
    } else if (looksLikeScrypt(dbHash)) {
      // Handle scrypt hashes (from older complete-setup route)
      passOk = await verifyScrypt(String(password), String(dbHash));
      // Upgrade to bcrypt on successful login
      if (passOk) {
        const newHash = await bcrypt.hash(String(password), 12);
        await db.collection("users").updateOne(
          { _id: user._id },
          { $set: { passwordHash: newHash } }
        );
      }
    } else if (legacyPlain) {
      // Compare plaintext legacy; if ok, upgrade to bcrypt
      passOk = String(password) === String(legacyPlain);
      if (passOk) {
        const newHash = await bcrypt.hash(String(password), 12);
        await db.collection("users").updateOne(
          { _id: user._id },
          { $set: { passwordHash: newHash }, $unset: { password: "" } }
        );
      }
    }

    if (!passOk) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Create session
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days

    await db.collection("sessions").insertOne({
      token,
      userId: user._id,
      shopId: Number(user.shopId ?? shopId ?? 0),
      createdAt: new Date(),
      expiresAt,
    });

    // ✅ Next.js 15: await cookies() before using it
    const store = await cookies();
    store.set(
      "session_token",
      token,
      sessionCookieOptions(60 * 60 * 24 * 30) // maxAge in seconds
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Login error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
