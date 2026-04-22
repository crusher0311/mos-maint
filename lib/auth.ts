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
  isImpersonation?: boolean;
  impersonatedBy?: string;
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

  const devAutoLoginEnabled =
    process.env.NODE_ENV === "development" && process.env.DEV_AUTO_LOGIN === "true";
  const devSession: SessionInfo = {
    token: "dev-auto-login",
    shopId: Number(process.env.DEV_SHOP_ID || "1"),
    email: process.env.DEV_USER_EMAIL || "dev@example.com",
    role: "owner",
    isPlatformAdmin: process.env.DEV_PLATFORM_ADMIN === "true",
  };

  if (!token) {
    // Fallback: Chrome extension auth via "Authorization: Bearer ext_*".
    // The extension never sets the session_token cookie, so without this
    // fallback every getSession()-protected route returns 401 to the
    // extension even though its token is valid against /api/auth/verify.
    const hdrs = await headers();
    const authHeader = hdrs.get("authorization") || hdrs.get("Authorization");
    if (authHeader?.toLowerCase().startsWith("bearer ext_")) {
      const extToken = authHeader.substring(7);
      try {
        const db = await getDb();
        const user = await db
          .collection("users")
          .findOne({ extensionToken: extToken });
        if (user) {
          // Optional 30-day token age check (mirror lib/extension-auth.ts).
          const createdAt = user.extensionTokenCreatedAt
            ? new Date(user.extensionTokenCreatedAt).getTime()
            : null;
          const expired =
            createdAt !== null &&
            Date.now() - createdAt > 30 * 24 * 60 * 60 * 1000;
          if (!expired) {
            // Resolve target shopId: prefer explicit override headers/query
            // (extension may set x-mos-shop-id when working in a specific
            // shop), otherwise fall back to the user's primary shop.
            const overrideShop =
              hdrs.get("x-mos-shop-id") ||
              hdrs.get("X-MOS-Shop-Id") ||
              null;
            const userShopIds: (string | number)[] = [
              ...(user.shopId ? [user.shopId] : []),
              ...(Array.isArray(user.shopIds) ? user.shopIds : []),
            ];
            const isPlatformAdmin = user.role === "platform_admin";
            let shopId = Number(user.shopId ?? userShopIds[0] ?? 0);
            if (overrideShop) {
              const o = String(overrideShop);
              const allowed =
                isPlatformAdmin ||
                userShopIds.map((id) => String(id)).includes(o);
              if (allowed) shopId = Number(o);
            }
            if (shopId) {
              return {
                token: extToken,
                shopId,
                email: String(user.email ?? ""),
                role: String(user.role ?? "owner"),
                isPlatformAdmin: Boolean(
                  user.isPlatformAdmin || isPlatformAdmin,
                ),
              };
            }
          }
        }
      } catch (err) {
        console.warn("[Auth] Extension token fallback failed:", err);
      }
    }
    return devAutoLoginEnabled ? devSession : null;
  }

  const db = await getDb();
  const sess = await db.collection("sessions").findOne({
    token,
    expiresAt: { $gt: new Date() },
  });
  if (!sess) {
    // Stale cookie (session wiped, expired, or container restart). In dev, fall back to auto-login
    // so engineers don't have to manually clear cookies after every Mongo reset.
    return devAutoLoginEnabled ? devSession : null;
  }

  const user = await db.collection("users").findOne(
    { _id: sess.userId },
    { projection: { email: 1, role: 1, isPlatformAdmin: 1 } }
  );
  if (!user) {
    return devAutoLoginEnabled ? devSession : null;
  }

  return {
    token,
    shopId: Number(sess.shopId),
    email: String(user.email),
    role: String(user.role ?? "owner"),
    isPlatformAdmin: Boolean(user.isPlatformAdmin),
    isImpersonation: Boolean(sess.isImpersonation),
    impersonatedBy: sess.impersonatedBy ? String(sess.impersonatedBy) : undefined,
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
