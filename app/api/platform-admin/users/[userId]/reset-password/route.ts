import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import { ObjectId } from "mongodb";
import crypto from "node:crypto";
import { sendEmail } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { userId: string } }
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { userId } = params;

  const db = await getDb();
  const users = db.collection("users");

  const user = await users.findOne({ _id: new ObjectId(userId) });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.collection("password_reset_tokens").insertOne({
    token,
    userId: user._id,
    email: user.email,
    createdAt: new Date(),
    expiresAt,
  });

  const base =
    process.env.NEXT_PUBLIC_BASE_URL ||
    `https://${req.headers.get("host") || "localhost:3000"}`;
  const resetUrl = `${base}/reset-password?token=${token}`;

  let emailSent = false;
  try {
    await sendEmail({
      to: user.email,
      subject: "Reset Your Password - My Oil Sticker",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #1e40af;">Reset Your Password</h2>
          <p>Hi,</p>
          <p>We received a request to reset your password for My Oil Sticker.</p>
          <p>Click the button below to set a new password:</p>
          <p style="margin: 24px 0;">
            <a href="${resetUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
              Reset Password
            </a>
          </p>
          <p style="color: #666; font-size: 14px;">This link will expire in 24 hours.</p>
          <p style="color: #666; font-size: 14px;">If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });
    emailSent = true;
  } catch (err) {
    console.error("Failed to send password reset email:", err);
  }

  return NextResponse.json({
    ok: true,
    emailSent,
    email: user.email,
  });
}
