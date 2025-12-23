import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sessionCookieOptions } from "@/lib/auth";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const shopId = Number(body?.shopId);
    const token = String(body?.token || "");
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password || "");

    if (!shopId || !token || !email || !password) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const db = await getDb();
    const setup = db.collection("setup_tokens");
    const users = db.collection("users");
    const sessions = db.collection("sessions");

    // validate token
    const now = new Date();
    const invite = await setup.findOne({ token, shopId, expiresAt: { $gt: now } });
    if (!invite) {
      return NextResponse.json({ error: "Invalid or expired setup token" }, { status: 401 });
    }

    // enforce email if invite specified one
    const inviteEmail = (invite.emailLower || "").toLowerCase();
    if (inviteEmail && inviteEmail !== email) {
      return NextResponse.json({ error: "Email does not match invite" }, { status: 403 });
    }

    // role: from invite OR default to "user"
    const role = invite.role || "user";

    // ensure uniqueness per shop
    const exists = await users.findOne({ shopId, emailLower: email });
    if (exists) {
      return NextResponse.json({ error: "User already exists for this shop" }, { status: 409 });
    }

    // hash password with bcrypt (consistent with login/setup)
    const passwordHash = await bcrypt.hash(password, 12);

    // create user
    const now2 = new Date();
    const insert = await users.insertOne({
      shopId,
      email,
      emailLower: email,
      role,
      passwordHash,
      createdAt: now2,
      updatedAt: now2,
    });

    // single-use token: remove after success
    await setup.deleteOne({ _id: invite._id });

    // create session
    const sessionToken = crypto.randomBytes(32).toString("hex");
    const ttlDays = 30;
    const expiresAt = new Date(now2.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    await sessions.insertOne({
      token: sessionToken,
      userId: insert.insertedId,
      shopId,
      createdAt: now2,
      expiresAt,
    });

    const res = NextResponse.json({ ok: true, redirect: "/dashboard", shopId, role });
    res.cookies.set("session_token", sessionToken, sessionCookieOptions(ttlDays * 24 * 60 * 60));
    return res;
  } catch (e: any) {
    console.error("Complete setup error:", e);
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}

