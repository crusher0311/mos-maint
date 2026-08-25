import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";
import { clientIp, rateLimit } from "@/lib/rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/extension/auth/request-code
 * Body: { email: string }
 *
 * Passwordless sign-in step 1 for the browser extension: emails the account a
 * single-use 6-digit code (10-minute TTL). Step 2 is POST /api/extension/auth
 * with { email, loginCode } instead of a password, which issues the same
 * verified 30-day extension session as a password login.
 *
 * Security properties (mirrors /api/auth/forgot):
 * - Always returns 200 — never reveals whether the email has an account.
 * - Rate limited per IP+email.
 * - Only the SHA-256 hash of the code is stored; codes are single-use,
 *   short-lived, and capped at 5 verify attempts (enforced by the auth route).
 * - Requesting a new code supersedes any outstanding one for that email.
 */

const CODE_TTL_MS = 10 * 60 * 1000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

function makeCodeEmail(code: string) {
  const subject = "Your MOS.Tools sign-in code";
  const text = `Your MOS.Tools sign-in code is: ${code}\n\nEnter it in the MOS.Tools extension to finish signing in. It expires in 10 minutes and can only be used once.\n\nIf you didn't request this, you can ignore this email.`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;">
      <h2 style="color:#111;">Your MOS.Tools sign-in code</h2>
      <p style="font-size:32px;letter-spacing:8px;font-weight:bold;background:#f4f4f5;border-radius:8px;padding:16px 24px;text-align:center;">${code}</p>
      <p>Enter this code in the MOS.Tools extension to finish signing in.</p>
      <p style="color:#666;">It expires in <b>10 minutes</b> and can only be used once. If you didn't request this, you can ignore this email.</p>
    </div>`;
  return { subject, text, html };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const emailLower = String(body?.email || "").trim().toLowerCase();

    const ip = clientIp(req);
    const rl = await rateLimit({
      id: `ext-login-code:${ip}:${emailLower || "_"}`,
      limit: 5,
      windowSeconds: 15 * 60,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many requests. Try again later." },
        { status: 429, headers: corsHeaders },
      );
    }

    // Always report success below this point — no account enumeration.
    if (!emailLower || !emailLower.includes("@")) {
      return NextResponse.json({ ok: true }, { headers: corsHeaders });
    }

    const db = await getDb();
    const user = await db.collection("users").findOne({ email: emailLower });
    if (!user || user.active === false) {
      return NextResponse.json({ ok: true }, { headers: corsHeaders });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const now = new Date();
    const codes = db.collection("extension_login_codes");
    // A new request supersedes any outstanding code for this email.
    await codes.updateMany(
      { emailLower, usedAt: null },
      { $set: { usedAt: now, supersededAt: now } },
    );
    await codes.insertOne({
      emailLower,
      codeHash: hashCode(code),
      createdAt: now,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      usedAt: null,
      attempts: 0,
    });

    const { subject, text, html } = makeCodeEmail(code);
    // No shopId: auth mail intentionally bypasses the shop approval gate,
    // same as password reset.
    await sendEmail({ to: user.email, subject, html, text });

    console.info(`[Extension Login Code] issued code for ${emailLower.replace(/^(..).*(@.*)$/, "$1***$2")}`);
    return NextResponse.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    console.error("[Extension Login Code] request failed:", error);
    return NextResponse.json(
      { ok: false, error: "Unable to send code" },
      { status: 500, headers: corsHeaders },
    );
  }
}
