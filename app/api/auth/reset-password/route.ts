import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { token, password } = body;

    if (!token || !password) {
      return NextResponse.json({ error: "Token and password required" }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const db = await getDb();
    
    const resetToken = await db.collection("password_reset_tokens").findOne({
      token,
      expiresAt: { $gt: new Date() },
    });

    if (!resetToken) {
      return NextResponse.json({ error: "Invalid or expired token" }, { status: 404 });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await db.collection("users").updateOne(
      { _id: resetToken.userId },
      { $set: { password: hashedPassword, updatedAt: new Date() } }
    );

    await db.collection("password_reset_tokens").deleteOne({ _id: resetToken._id });

    await db.collection("password_reset_tokens").deleteMany({ userId: resetToken.userId });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Password reset error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
