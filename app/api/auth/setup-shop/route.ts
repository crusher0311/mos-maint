import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import bcrypt from "bcryptjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { shopName, newPassword } = body;

  if (!shopName || typeof shopName !== "string" || shopName.trim().length < 2) {
    return NextResponse.json(
      { error: "Shop name is required (at least 2 characters)" },
      { status: 400 }
    );
  }

  const db = await getDb();

  const shop = await db.collection("shops").findOne({ shopId: sess.shopId });
  if (!shop?.provisionedVia || shop?.setupCompleted) {
    return NextResponse.json(
      { error: "Setup is not required for this account" },
      { status: 403 }
    );
  }

  // If this user is gated on `mustChangePassword` (e.g. fresh provisioning
  // or a platform-admin force-reset), the setup-shop flow MUST collect a
  // new password — otherwise the setup screen would be a back door around
  // the gate. Use the same strength rules as /api/auth/change-password.
  const existingUser = await db.collection("users").findOne(
    { email: sess.email, shopId: sess.shopId },
    { projection: { _id: 1, mustChangePassword: 1, passwordHash: 1 } }
  );
  const userMustChangePassword = !!existingUser?.mustChangePassword;

  const validatePasswordStrength = (pwd: string): string | null => {
    if (typeof pwd !== "string") return "Password must be a string.";
    if (pwd.length < 12) return "Password must be at least 12 characters long.";
    if (pwd.length > 200) return "Password is too long.";
    const classes = [
      /[a-z]/.test(pwd),
      /[A-Z]/.test(pwd),
      /[0-9]/.test(pwd),
      /[^a-zA-Z0-9]/.test(pwd),
    ].filter(Boolean).length;
    if (classes < 3) {
      return "Password must include at least 3 of: lowercase, uppercase, digits, symbols.";
    }
    return null;
  };

  if (userMustChangePassword) {
    if (typeof newPassword !== "string" || !newPassword) {
      return NextResponse.json(
        { error: "A new password is required to finish setting up this account." },
        { status: 400 }
      );
    }
    const strengthError = validatePasswordStrength(newPassword);
    if (strengthError) {
      return NextResponse.json({ error: strengthError }, { status: 400 });
    }
  }

  const sanitizedName = shopName.trim().slice(0, 200);

  await db.collection("shops").updateOne(
    { shopId: sess.shopId },
    {
      $set: {
        name: sanitizedName,
        setupCompleted: true,
        updatedAt: new Date(),
      },
    }
  );

  type UserUpdate = {
    updatedAt: Date;
    passwordHash?: string;
    passwordChangedAt?: Date;
    mustChangePassword?: boolean;
    passwordResetByAdminAt?: Date | null;
  };
  const userUpdate: UserUpdate = {
    updatedAt: new Date(),
  };

  // Only clear the gate if either the user was never gated, or they
  // supplied a new password we just validated.
  const willClearGate =
    !userMustChangePassword ||
    (typeof newPassword === "string" && newPassword.length > 0);

  if (typeof newPassword === "string" && newPassword.length > 0) {
    userUpdate.passwordHash = await bcrypt.hash(newPassword, 12);
    userUpdate.passwordChangedAt = new Date();
  }

  await db.collection("users").updateOne(
    { email: sess.email, shopId: sess.shopId },
    { $set: userUpdate }
  );

  // Also clear the password-change gate from any active sessions belonging to
  // this user so the middleware lets them out of the change-password flow.
  const userDoc = await db.collection("users").findOne(
    { email: sess.email, shopId: sess.shopId },
    { projection: { _id: 1 } }
  );
  if (userDoc?._id && willClearGate) {
    await db.collection("sessions").updateMany(
      { userId: userDoc._id },
      { $unset: { mustChangePassword: "" } }
    );
    await db.collection("users").updateOne(
      { _id: userDoc._id },
      { $unset: { mustChangePassword: "" } }
    );
  }

  // Drop the middleware gating cookie too — the user just completed the
  // first-time setup flow that doubles as their password change.
  if (willClearGate) {
    try {
      const { cookies } = await import("next/headers");
      const cookieStore = await cookies();
      cookieStore.delete("mcp_flag");
    } catch {
      // Best-effort.
    }
  }

  return NextResponse.json({
    success: true,
    shopName: sanitizedName,
  });
}
