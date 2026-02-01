import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import sql from "@/lib/db/postgres";
import { sendEmail, makeResetEmail } from "@/lib/email";
import { clientIp, rateLimit } from "@/lib/rate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const rawEmail = String(body?.email || "");
    const emailLower = rawEmail.trim().toLowerCase();
    const rawShopId = body?.shopId;
    const shopId = Number.isFinite(rawShopId) ? Number(rawShopId) : undefined;

    const ip = clientIp(req);
    const rl = await rateLimit({
      id: `forgot:${ip}:${emailLower || "_"}:${shopId ?? "_"}`,
      limit: 5,
      windowSeconds: 60 * 60,
    });
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many requests. Try again later." },
        { status: 429 }
      );
    }

    if (!emailLower) {
      return NextResponse.json({
        ok: true,
        note: "If the account exists, a reset link will be generated.",
      });
    }

    let user: Record<string, unknown> | null = null;
    let note: string | undefined;

    if (typeof shopId === "number") {
      const result = await sql`
        SELECT id, email, shop_id FROM users 
        WHERE LOWER(email) = ${emailLower} AND shop_id = ${String(shopId)}
        LIMIT 1
      `;
      user = result[0] || null;
    } else {
      const matches = await sql`
        SELECT id, email, shop_id FROM users 
        WHERE LOWER(email) = ${emailLower}
        LIMIT 2
      `;
      if (matches.length === 1) {
        user = matches[0];
      } else if (matches.length > 1) {
        note = "Multiple accounts found for this email. Please include your Shop ID.";
        return NextResponse.json({ ok: true, note });
      }
    }

    if (!user) {
      return NextResponse.json({
        ok: true,
        note: note ?? "If the account exists, a reset link will be generated.",
      });
    }

    const token = crypto.randomBytes(24).toString("hex");
    const now = new Date();
    const expiresMinutes = 120;
    const expiresAt = new Date(now.getTime() + expiresMinutes * 60 * 1000);

    await sql`
      INSERT INTO password_reset_tokens (token, user_id, shop_id, email_lower, created_at, expires_at, used_at)
      VALUES (${token}, ${user.id as string}, ${user.shop_id as string}, ${emailLower}, ${now}, ${expiresAt}, NULL)
    `;

    const base = process.env.PUBLIC_BASE_URL || req.nextUrl.origin;
    const resetUrl = `${base}/reset?token=${token}`;

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
      note,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
