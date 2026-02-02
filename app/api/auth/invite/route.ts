import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import crypto from "node:crypto";
import { sendEmail, makeInviteEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await safeJson(req);
  const emailInput = String(body?.email || "").trim().toLowerCase();
  const inviteRole = (String(body?.role || "user").trim().toLowerCase()) as
    | "owner"
    | "admin"
    | "manager"
    | "user"
    | "viewer";

  if (!emailInput) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const db = await getDb();
  const setup = db.collection("setup_tokens");

  const shop = await db.collection("shops").findOne({ shopId: sess.shopId });
  const shopName = shop?.name || `Shop #${sess.shopId}`;
  const locationIdentifier = shop?.locationIdentifier || null;

  const token = crypto.randomBytes(16).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await setup.insertOne({
    token,
    shopId: sess.shopId,
    emailLower: emailInput,
    role: inviteRole,
    createdAt: now,
    expiresAt,
  });

  const base =
    process.env.NEXT_PUBLIC_BASE_URL ||
    `https://${req.headers.get("host") || "localhost:3000"}`;
  const setupUrl = `${base}/setup?shopId=${sess.shopId}&token=${token}`;

  let emailSent = false;
  try {
    const msg = makeInviteEmail(setupUrl, shopName, locationIdentifier, inviteRole);
    await sendEmail({ to: emailInput, ...msg });
    emailSent = true;
  } catch (err) {
    console.error("Failed to send invite email:", err);
  }

  return NextResponse.json({ ok: true, setupUrl, emailSent, email: emailInput });
}

async function safeJson(req: NextRequest) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

