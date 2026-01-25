// lib/auth.ts
import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/mongo";
import { getTestAuthFromHeaders, isTestAuthEnabled } from "@/lib/test-auth";

export const SESSION_COOKIE = "session_token";

export type SessionInfo = {
  token: string;
  shopId: number;
  email: string;
  role: string;
  isPlatformAdmin?: boolean;
  isTestAuth?: boolean;
};

export async function getSession(): Promise<SessionInfo | null> {
  // E2E Test Auth Bypass - check header first
  if (isTestAuthEnabled()) {
    const hdrs = await headers();
    const testAuth = getTestAuthFromHeaders(hdrs);
    if (testAuth) {
      return {
        token: "e2e-test-auth",
        shopId: testAuth.shopId,
        email: testAuth.email,
        role: testAuth.role,
        isPlatformAdmin: testAuth.isPlatformAdmin,
        isTestAuth: true,
      };
    }
  }

  // ✅ Next.js 15: await cookies()
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  
  // Dev auto-login: skip auth in development mode
  if (!token && process.env.NODE_ENV === "development" && process.env.DEV_AUTO_LOGIN === "true") {
    const devShopId = Number(process.env.DEV_SHOP_ID || "1");
    const devEmail = process.env.DEV_USER_EMAIL || "dev@example.com";
    return {
      token: "dev-auto-login",
      shopId: devShopId,
      email: devEmail,
      role: "owner",
    };
  }
  
  if (!token) return null;

  const db = await getDb();
  const sess = await db.collection("sessions").findOne({
    token,
    expiresAt: { $gt: new Date() },
  });
  if (!sess) return null;

  const user = await db.collection("users").findOne(
    { _id: sess.userId },
    { projection: { email: 1, role: 1, isPlatformAdmin: 1 } }
  );
  if (!user) return null;

  return {
    token,
    shopId: Number(sess.shopId),
    email: String(user.email),
    role: String(user.role ?? "owner"),
    isPlatformAdmin: Boolean(user.isPlatformAdmin),
  };
}

export async function requirePlatformAdmin(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) redirect("/admin-login");
  if (!s.isPlatformAdmin) redirect("/dashboard");
  return s!; // Non-null assertion since redirect throws
}

export async function requireSession(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s!; // Non-null assertion since redirect throws
}

export function sessionCookieOptions(maxAgeSeconds = 60 * 60 * 24 * 30) {
  return {
    httpOnly: true as const,
    secure: true as const,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function adminSessionCookieOptions(maxAgeSeconds = 60 * 60 * 8) {
  return {
    httpOnly: true as const,
    secure: true as const,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}
