import { NextRequest, NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { logAdminAction } from "@/lib/audit-log";
import { MUST_CHANGE_PASSWORD_COOKIE } from "@/lib/must-change-password-cookie";
import { dualWritePgIdentity } from "@/lib/db/wave4-write-mode";
import {
  clearMustChangePasswordByToken as pgClearMcpByToken,
  deleteSessionsByUserIdExceptToken as pgDeleteOtherSessions,
  updateUserPassword as pgUpdateUserPassword,
} from "@/lib/data/repositories/pg/identity";

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

function looksLikeBcrypt(s: unknown) {
  return typeof s === "string" && /^\$2[aby]\$/.test(s);
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bodyObj: Record<string, unknown> =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const currentPassword: unknown = bodyObj.currentPassword;
  const newPassword: unknown = bodyObj.newPassword;

  if (typeof currentPassword !== "string" || !currentPassword) {
    return NextResponse.json(
      { error: "currentPassword is required" },
      { status: 400 }
    );
  }
  if (typeof newPassword !== "string" || !newPassword) {
    return NextResponse.json(
      { error: "newPassword is required" },
      { status: 400 }
    );
  }
  if (currentPassword === newPassword) {
    return NextResponse.json(
      { error: "New password must be different from current password." },
      { status: 400 }
    );
  }

  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) {
    return NextResponse.json({ error: strengthError }, { status: 400 });
  }

  try {
    const db = await getDb();

    // Resolve the acting user. We use email + shopId to be consistent with
    // how `/api/auth/me` looks them up, since session info is what we have.
    const user = await db.collection("users").findOne(
      { email: session.email, shopId: session.shopId },
      { projection: { _id: 1, passwordHash: 1, mustChangePassword: 1 } }
    );

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const dbHash = user.passwordHash;
    if (!looksLikeBcrypt(dbHash)) {
      return NextResponse.json(
        { error: "Password change is not available for this account. Please reset your password." },
        { status: 400 }
      );
    }

    const passOk = await bcrypt.compare(String(currentPassword), String(dbHash));
    if (!passOk) {
      return NextResponse.json(
        { error: "Current password is incorrect" },
        { status: 401 }
      );
    }

    const now = new Date();
    const passwordHash = await bcrypt.hash(newPassword, 12);

    await db.collection("users").updateOne(
      { _id: user._id },
      {
        $set: {
          passwordHash,
          updatedAt: now,
          passwordChangedAt: now,
        },
        $unset: {
          password: "",
          mustChangePassword: "",
          passwordResetByAdminAt: "",
          passwordResetByAdminEmail: "",
        },
      }
    );

    // W4 cutover (#346): mirror the user-level password change AND
    // the must-change-password clear into PG. Without this, a user
    // whose PG row carries `must_change_password=true` (from
    // pre-cutover backfill) would be permanently gated when PG is
    // canonical, even after a successful password change.
    await dualWritePgIdentity("users.update(change-password)", () =>
      pgUpdateUserPassword(String(user._id), {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: now,
        passwordResetByAdminAt: null,
        passwordResetByAdminEmail: null,
      }),
    );

    // Clear the gating flag from the current session so the user can use
    // the app immediately, and revoke any other sessions they may have
    // (e.g. created with the temporary admin-chosen password elsewhere).
    const userObjectId = user._id as ObjectId;
    await db.collection("sessions").updateOne(
      { token: session.token },
      { $unset: { mustChangePassword: "" } }
    );
    const otherSessions = await db
      .collection("sessions")
      .deleteMany({
        userId: userObjectId,
        token: { $ne: session.token },
      });

    // W4 cutover (#346): mirror the gate-clear + revoke into PG so
    // the user isn't bounced back into the change-password flow on
    // their next request and stale sessions can't be reused.
    await dualWritePgIdentity("sessions.clearMcp(change-password)", () =>
      pgClearMcpByToken(session.token),
    );
    await dualWritePgIdentity("sessions.deleteOthers(change-password)", () =>
      pgDeleteOtherSessions(String(userObjectId), session.token),
    );

    const wasAdminForced = !!user.mustChangePassword;
    if (wasAdminForced) {
      try {
        const headerStore = await headers();
        await logAdminAction({
          action: "user_password_changed_after_force_reset",
          adminEmail: session.email,
          targetShopId: session.shopId,
          targetUserEmail: session.email,
          ipAddress:
            headerStore.get("x-forwarded-for") ||
            headerStore.get("x-real-ip") ||
            undefined,
          userAgent: headerStore.get("user-agent") || undefined,
          details: {
            otherSessionsRevoked: otherSessions.deletedCount ?? 0,
          },
        });
      } catch (logErr) {
        // Audit logging is best-effort - don't block the password change.
        console.warn("Failed to log password change audit event:", logErr);
      }
    }

    // Clear the middleware gating cookie so the user can navigate freely
    // again immediately after a successful password change.
    try {
      const cookieStore = await cookies();
      cookieStore.delete(MUST_CHANGE_PASSWORD_COOKIE);
    } catch {
      // Best-effort: response is still ok even if cookie deletion throws.
    }

    return NextResponse.json({
      ok: true,
      message: "Password changed successfully",
      otherSessionsRevoked: otherSessions.deletedCount ?? 0,
    });
  } catch (err: unknown) {
    console.error("Error changing user password:", err);
    const message =
      err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
