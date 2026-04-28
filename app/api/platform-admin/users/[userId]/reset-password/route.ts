import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { logAdminAction } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_PASSWORD_LENGTH = 12;

function validatePasswordStrength(password: string): string | null {
  if (typeof password !== "string") {
    return "Password must be a string.";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (password.length > 200) {
    return "Password is too long.";
  }
  const classes = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^a-zA-Z0-9]/.test(password),
  ].filter(Boolean).length;
  if (classes < 3) {
    return "Password must include at least 3 of: lowercase, uppercase, digits, symbols.";
  }
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json(
      { error: "Forbidden - platform admin access required" },
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const newPassword: unknown = body?.newPassword;
  if (typeof newPassword !== "string" || !newPassword) {
    return NextResponse.json(
      { error: "newPassword is required" },
      { status: 400 }
    );
  }

  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) {
    return NextResponse.json({ error: strengthError }, { status: 400 });
  }

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(params.userId);
  } catch {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const targetUser = await db
      .collection("users")
      .findOne(
        { _id: objectId },
        { projection: { email: 1, shopId: 1 } }
      );

    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const now = new Date();

    await db.collection("users").updateOne(
      { _id: objectId },
      {
        $set: {
          passwordHash,
          updatedAt: now,
          passwordResetByAdminAt: now,
          passwordResetByAdminEmail: session.email,
        },
        $unset: { password: "" },
      }
    );

    const sessionsResult = await db
      .collection("sessions")
      .deleteMany({ userId: objectId });

    const headerStore = await headers();
    await logAdminAction({
      action: "user_password_reset",
      adminEmail: session.email,
      targetShopId: targetUser.shopId,
      targetUserEmail: targetUser.email,
      ipAddress:
        headerStore.get("x-forwarded-for") ||
        headerStore.get("x-real-ip") ||
        undefined,
      userAgent: headerStore.get("user-agent") || undefined,
      details: {
        sessionsRevoked: sessionsResult.deletedCount ?? 0,
      },
    });

    return NextResponse.json({
      ok: true,
      message: "Password reset successfully",
      sessionsRevoked: sessionsResult.deletedCount ?? 0,
    });
  } catch (err: any) {
    console.error("Error resetting user password:", err);
    return NextResponse.json(
      { error: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
