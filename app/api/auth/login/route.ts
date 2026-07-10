// app/api/auth/login/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { getDb } from "@/lib/mongo";
import { sessionCookieOptions } from "@/lib/auth";
import { dualWritePgIdentity } from "@/lib/db/wave4-write-mode";
import { insertSession as pgInsertSession } from "@/lib/data/repositories/pg/identity";
import {
  MUST_CHANGE_PASSWORD_COOKIE,
  mustChangePasswordCookieOptions,
  signMustChangePasswordToken,
} from "@/lib/must-change-password-cookie";

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
      .project({ _id: 1, email: 1, role: 1, passwordHash: 1, password: 1, shopId: 1, mustChangePassword: 1, status: 1 })
      .toArray();

    if (candidates.length === 0) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Pick first user if multiple shops (user can switch via sidebar dropdown)
    const user = candidates[0];

    // Password checks with graceful migration. The plaintext-password
    // fallback was removed (see task #302); users whose row has no
    // bcrypt/scrypt hash must reset their password rather than being
    // silently rehashed from a plaintext column.
    const dbHash = user.passwordHash;

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
    }

    if (!passOk) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Enrollment-code signups in approval mode can't log in until a shop
    // admin approves them (see /api/join/[code] + the approval route).
    if (user.status === "pending") {
      return NextResponse.json(
        {
          error:
            "Your account is waiting for approval from a shop admin. You'll get an email once you're approved.",
          pendingApproval: true,
        },
        { status: 403 }
      );
    }

    // Create session
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days

    const mustChangePassword = !!user.mustChangePassword;
    const sessionShopId = Number(user.shopId ?? shopId ?? 0);

    await db.collection("sessions").insertOne({
      token,
      userId: user._id,
      shopId: sessionShopId,
      createdAt: new Date(),
      expiresAt,
      mustChangePassword,
    });

    // W4 cutover (#346): when PG is canonical, the very next request
    // hits `lib/auth.ts` → `pgFindActiveSession(token)`; the session
    // must therefore be present in PG before this handler returns.
    await dualWritePgIdentity("sessions.insert(login)", () =>
      pgInsertSession({
        token,
        userId: String(user._id),
        shopId: sessionShopId,
        mustChangePassword,
        expiresAt,
      }),
    );

    // ✅ Next.js 15: await cookies() before using it
    const store = await cookies();
    store.set(
      "session_token",
      token,
      sessionCookieOptions(60 * 60 * 24 * 30) // maxAge in seconds
    );

    if (mustChangePassword) {
      // Set the signed cookie that middleware uses to gate every other path
      // until the user changes their password. Bound to this exact session
      // token (HMAC of the token), so it's invalidated automatically the
      // moment the session changes.
      store.set(
        MUST_CHANGE_PASSWORD_COOKIE,
        signMustChangePasswordToken(token),
        mustChangePasswordCookieOptions(60 * 60 * 24 * 30),
      );

      // If this is a freshly-provisioned shop that hasn't completed first-run
      // setup, prefer the existing onboarding flow (which collects shop name
      // and a new password in one step). Otherwise, send them to the
      // dedicated change-password screen.
      let redirect = "/change-password";
      try {
        const shop = await db.collection("shops").findOne(
          { shopId: sessionShopId },
          { projection: { provisionedVia: 1, setupCompleted: 1 } }
        );
        if (shop?.provisionedVia && !shop?.setupCompleted) {
          redirect = "/dashboard/setup-shop";
        }
      } catch {
        // Fall through with the default redirect.
      }

      return NextResponse.json({
        ok: true,
        mustChangePassword: true,
        redirect,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Login error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
