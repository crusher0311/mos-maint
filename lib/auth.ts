// lib/auth.ts
import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
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
  mustChangePassword?: boolean;
};

// Paths a user with `mustChangePassword: true` is allowed to reach before
// they have set a new password. Mirrors the allowlist in middleware.ts so
// pages/server actions enforce the gate even if the middleware is bypassed
// (e.g. user manually deletes the `mcp_flag` cookie in devtools).
const PASSWORD_CHANGE_ALLOWED_PATHS = new Set<string>([
  "/change-password",
  "/api/auth/change-password",
  "/api/auth/me",
  "/api/auth/logout",
  "/dashboard/setup-shop",
  "/api/auth/setup-shop",
  "/api/shop/features",
]);

function isPasswordChangeAllowedPath(pathname: string): boolean {
  if (PASSWORD_CHANGE_ALLOWED_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico" || pathname === "/icon.png") return true;
  return false;
}

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
    {
      projection: {
        email: 1,
        role: 1,
        isPlatformAdmin: 1,
        mustChangePassword: 1,
      },
    }
  );
  if (!user) {
    return devAutoLoginEnabled ? devSession : null;
  }

  // Either the session OR the user document carrying `mustChangePassword`
  // is enough to consider the user gated. The session copy keeps post-reset
  // logins gated even if the user record races; the user copy keeps the
  // gate in effect across new sessions until the user actually changes
  // their password.
  const mustChangePassword =
    Boolean(sess.mustChangePassword) || Boolean(user.mustChangePassword);

  const session: SessionInfo = {
    token,
    shopId: Number(sess.shopId),
    email: String(user.email),
    role: String(user.role ?? "owner"),
    isPlatformAdmin: Boolean(user.isPlatformAdmin),
    isImpersonation: Boolean(sess.isImpersonation),
    impersonatedBy: sess.impersonatedBy
      ? String(sess.impersonatedBy)
      : undefined,
    mustChangePassword,
  };

  // Authoritative server-side enforcement of the post-force-reset gate.
  // We do this at the bottom of `getSession()` so that ANY page or API that
  // resolves a session has the gate applied — not just the small subset
  // that explicitly call `requireSession()`. UI requests get redirected to
  // /change-password; API requests are left to either the middleware
  // (cookie-based fast path → 403) or their own handler logic, because
  // `redirect()` from a route handler in Next 14 manifests as a 500 and
  // would degrade response semantics.
  await enforcePasswordChangeGate(session);

  return session;
}

// Read the current request path from headers (server components/route
// handlers don't get it on the session itself). Falls back to "" if we
// can't determine it, which means we won't accidentally redirect.
async function currentPathname(): Promise<string> {
  try {
    const h = await headers();
    return (
      h.get("x-invoke-path") ||
      h.get("next-url") ||
      h.get("x-pathname") ||
      h.get("x-matched-path") ||
      ""
    );
  } catch {
    return "";
  }
}

/**
 * Thrown by `getSession()` when an authenticated user with
 * `mustChangePassword: true` tries to call any non-allowlisted API
 * route. This is the authoritative server-side enforcement of the
 * post-force-reset gate for API requests — middleware's cookie check
 * is only a fast-path optimization in front of it.
 *
 * Route handlers may catch this and respond with a clean 403 via
 * `passwordChangeRequiredResponse()`. If a handler does NOT catch it,
 * Next.js will return a 500 — also a denial — so the security
 * property ("user cannot use the app until they change their password")
 * holds regardless.
 */
export class PasswordChangeRequiredError extends Error {
  readonly status = 403 as const;
  constructor() {
    super("Password change required");
    this.name = "PasswordChangeRequiredError";
  }
}

export function isPasswordChangeRequiredError(
  err: unknown
): err is PasswordChangeRequiredError {
  return err instanceof PasswordChangeRequiredError;
}

export function passwordChangeRequiredResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "Password change required",
      mustChangePassword: true,
      redirect: "/change-password",
    },
    { status: 403 }
  );
}

async function enforcePasswordChangeGate(s: SessionInfo): Promise<void> {
  if (!s.mustChangePassword) return;
  const pathname = await currentPathname();
  // If we don't know the path (some runtimes), err on the side of NOT
  // gating — the dedicated change-password page will still get the
  // user to the right place via /api/auth/me on mount.
  if (!pathname) return;
  if (isPasswordChangeAllowedPath(pathname)) return;
  if (pathname.startsWith("/api/")) {
    // Authoritative enforcement for API routes: throw a typed error.
    // Route handlers may catch it for a clean 403; uncaught throws
    // surface as 500 — both are denials, neither is a bypass.
    throw new PasswordChangeRequiredError();
  }
  // For UI pages, redirect to /change-password (route handlers can't use
  // redirect() — it manifests as a 500 in Next 14).
  redirect("/change-password");
}

export async function requirePlatformAdmin(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) redirect("/admin-login");
  if (!s.isPlatformAdmin) redirect("/dashboard");
  return s; // Non-null since redirect throws
}

export async function requireSession(): Promise<SessionInfo> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s; // Non-null since redirect throws
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
