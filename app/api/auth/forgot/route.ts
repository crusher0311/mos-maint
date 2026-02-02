import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { getDb } from "@/lib/mongo";
import { sendEmail, makeResetEmail } from "@/lib/email";
import { clientIp, rateLimit } from "@/lib/rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/forgot
 * Body: { email: string, shopId?: number }
 *
 * Behavior:
 * - Normalizes email → emailLower
 * - If shopId is provided, looks up that exact account; otherwise tries to infer
 * - Always returns 200 to avoid user/email enumeration
 * - Creates a single-use token in password_reset_tokens (2h TTL by default)
 * - Returns { ok: true, resetUrl, expiresAt, note? } and tries to send an email
 */
export async function POST(req: NextRequest) {
  try {
    const db = await getDb();
    const users = db.collection("users");
    const pwTokens = db.collection("password_reset_tokens"); // ← renamed collection

    const body = await req.json().catch(() => ({}));
    const rawEmail = String(body?.email || "");
    const emailLower = rawEmail.trim().toLowerCase();
    const rawShopId = body?.shopId;
    const shopId = Number.isFinite(rawShopId) ? Number(rawShopId) : undefined;

    // ---- Rate limit (5 reqs / hour per IP + email + shop) ----
    const ip = clientIp(req);
    const rl = await rateLimit({
      id: `forgot:${ip}:${emailLower || "_"}:${shopId ?? "_"}`,
      limit: 5,
      windowSeconds: 60 * 60,
    });
    if (!rl.allowed) {
      // Still avoid enumeration; just say "try later"
      return NextResponse.json(
        { ok: false, error: "Too many requests. Try again later." },
        { status: 429 }
      );
    }

    // If no email provided, return 200 (do not leak)
    if (!emailLower) {
      return NextResponse.json({
        ok: true,
        note: "If the account exists, a reset link will be generated.",
      });
    }

    // Find the target user while avoiding leaks
    let user: any = null;
    let note: string | undefined;

    if (typeof shopId === "number") {
      user = await users.findOne({ emailLower, shopId });
    } else {
      // No shopId: see how many shops match this email (cap to 2 to detect ambiguity)
      const matches = await users.find({ emailLower }).project({ _id: 1, shopId: 1, emailLower: 1 }).limit(2).toArray();
      if (matches.length === 1) {
        user = await users.findOne({ _id: matches[0]._id });
      } else if (matches.length > 1) {
        // Ambiguous—return 200 with a soft hint but no enumeration
        note = "Multiple accounts found for this email. Please include your Shop ID.";
        // Don't proceed with token creation without a specific shopId
        return NextResponse.json({ ok: true, note });
      }
      // If 0 matches: continue and return ok:true below (no leak)
    }

    // If user not found, still return ok:true (avoid enumeration)
    if (!user) {
      return NextResponse.json({
        ok: true,
        note: note ?? "If the account exists, a reset link will be generated.",
      });
    }

    // Create a secure, single-use token
    const token = crypto.randomBytes(24).toString("hex");
    const now = new Date();

    // Default: 2 hours (adjust as needed)
    const expiresMinutes = 120;
    const expiresAt = new Date(now.getTime() + expiresMinutes * 60 * 1000);

    await pwTokens.insertOne({
      token,
      userId: user._id,
      shopId: user.shopId,
      emailLower,
      createdAt: now,
      expiresAt,
      usedAt: null,
    });

    // Build the reset URL
    const base = process.env.PUBLIC_BASE_URL || req.nextUrl.origin;
    const resetUrl = `${base}/reset?token=${token}`;

    // Try to send an email (non-blocking for success)
    try {
      const { subject, html, text } = makeResetEmail(resetUrl);
      await sendEmail({ to: user.email as string, subject, html, text });
    } catch (e) {
      console.warn("sendEmail failed:", e);
    }

    return NextResponse.json({
      ok: true,
      resetUrl,
      expiresAt,
      note, // includes the soft hint only when applicable
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
