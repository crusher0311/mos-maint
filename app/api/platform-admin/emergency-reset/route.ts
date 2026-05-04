import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getDb } from "@/lib/mongo";
import { logAdminAction } from "@/lib/audit-log";
import { dualWritePgIdentity } from "@/lib/db/wave4-write-mode";
import {
  deleteSessionsByUserId as pgDeleteSessionsByUserId,
  updateUserPassword as pgUpdateUserPassword,
} from "@/lib/data/repositories/pg/identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = headers();
  const auth = h.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function describeHash(val: unknown): string {
  if (typeof val !== "string" || !val) return "missing";
  if (val.startsWith("$2a$") || val.startsWith("$2b$") || val.startsWith("$2y$")) {
    return `bcrypt(len=${val.length}, prefix=${val.slice(0, 4)})`;
  }
  return `plaintext(len=${val.length})`;
}

export async function GET(req: NextRequest) {
  if (!authorized()) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const email = (url.searchParams.get("email") || "").toLowerCase().trim();
  if (!email) {
    return NextResponse.json({ ok: false, error: "email query param required" }, { status: 400 });
  }
  const db = await getDb();
  const user = await db.collection("users").findOne({ email });
  if (!user) {
    const variants = await db
      .collection("users")
      .find({ email: { $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } })
      .project({ email: 1, isPlatformAdmin: 1 })
      .toArray();
    return NextResponse.json({
      ok: false,
      found: false,
      caseInsensitiveMatches: variants,
    });
  }
  return NextResponse.json({
    ok: true,
    found: true,
    userId: String(user._id),
    email: user.email,
    isPlatformAdmin: !!user.isPlatformAdmin,
    shopId: user.shopId ?? null,
    passwordHash: describeHash(user.passwordHash),
    legacyPassword: describeHash(user.password),
    createdAt: user.createdAt ?? null,
    updatedAt: user.updatedAt ?? null,
  });
}

export async function POST(req: NextRequest) {
  if (!authorized()) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const email = typeof body?.email === "string" ? body.email.toLowerCase().trim() : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  if (!email || !newPassword) {
    return NextResponse.json(
      { ok: false, error: "email and newPassword required" },
      { status: 400 }
    );
  }
  if (newPassword.length < 12) {
    return NextResponse.json(
      { ok: false, error: "newPassword must be at least 12 characters" },
      { status: 400 }
    );
  }
  const db = await getDb();
  const user = await db.collection("users").findOne({ email });
  if (!user) {
    return NextResponse.json({ ok: false, error: "User not found" }, { status: 404 });
  }
  const hashed = await bcrypt.hash(newPassword, 12);
  const result = await db.collection("users").updateOne(
    { _id: user._id },
    {
      $set: { passwordHash: hashed, updatedAt: new Date() },
      $unset: { password: "" },
    }
  );

  // W4 cutover (#346): mirror the password update into PG so the user
  // can actually log in against the PG-canonical reader after the reset.
  await dualWritePgIdentity("users.update(emergency-reset)", () =>
    pgUpdateUserPassword(String(user._id), {
      passwordHash: hashed,
      passwordChangedAt: new Date(),
    }),
  );
  await db.collection("sessions").deleteMany({ userId: user._id });

  // W4 cutover (#346): mirror revocation into PG so the reset user
  // can't reuse a stale session against the PG-canonical reader.
  await dualWritePgIdentity("sessions.delete(emergency-reset)", () =>
    pgDeleteSessionsByUserId(String(user._id)),
  );
  const h = headers();
  await logAdminAction({
    action: "user_password_reset",
    adminEmail: `emergency-reset:${email}`,
    targetUserEmail: user.email,
    details: {
      route: "platform-admin/emergency-reset",
      via: "CRON_SECRET",
      isPlatformAdmin: !!user.isPlatformAdmin,
      sessionsRevoked: true,
    },
    ipAddress: h.get("x-forwarded-for") || h.get("x-real-ip") || undefined,
    userAgent: h.get("user-agent") || undefined,
  });
  return NextResponse.json({
    ok: true,
    userId: String(user._id),
    email: user.email,
    isPlatformAdmin: !!user.isPlatformAdmin,
    matched: result.matchedCount,
    modified: result.modifiedCount,
    sessionsRevoked: true,
    message: "Password reset. Old sessions revoked. Try logging in now.",
  });
}
