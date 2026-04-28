// middleware.ts
import { NextResponse, NextRequest } from "next/server";

const PUBLIC_PATHS = new Set([
  "/",
  "/login",
  "/forgot",
  "/reset",
  "/setup",
  "/admin-login",
  "/api/auth/login",
  "/api/auth/forgot",
  "/api/auth/reset",
  "/api/auth/complete-setup",
  "/api/auth/setup",
]);
const SESSION_COOKIE = "session_token";
const TEST_AUTH_HEADER = "x-test-auth";
const MUST_CHANGE_PASSWORD_COOKIE = "mcp_flag";

// Paths a user with `mustChangePassword: true` is allowed to reach before
// they have set a new password. Everything else is blocked / redirected.
// Includes `/dashboard/setup-shop` so the existing first-time onboarding
// flow (which also clears the flag) keeps working for newly provisioned
// shops where the flag is set on the user from the start.
const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  "/change-password",
  "/api/auth/change-password",
  "/api/auth/me",
  "/api/auth/logout",
  "/dashboard/setup-shop",
  "/api/auth/setup-shop",
  "/api/shop/features",
]);

function isPasswordChangeAllowedPath(pathname: string) {
  if (PASSWORD_CHANGE_ALLOWED_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico" || pathname === "/icon.png") return true;
  return false;
}

function isPublicPath(pathname: string) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/api/webhooks/")) return true;
  if (pathname.startsWith("/api/ping")) return true;
  if (pathname.startsWith("/api/e2e/")) return true;
  if (pathname.startsWith("/api/extension/")) return true;
  if (pathname.startsWith("/api/cron/")) return true;
  if (pathname.startsWith("/api/platform-admin/log-stream")) return true;
  if (pathname.startsWith("/api/external/")) return true;
  if (pathname.startsWith("/api/docs")) return true;
  if (pathname.startsWith("/report/")) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (
    pathname === "/favicon.ico" ||
    pathname === "/robots.txt" ||
    pathname === "/sitemap.xml"
  )
    return true;
  return false;
}

// --- Web Crypto helpers (Edge-runtime safe) ---------------------------------

function base64UrlEncode(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.byteLength; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return base64UrlEncode(sig);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyTestTokenInMiddleware(
  token: string,
  secret: string,
): Promise<boolean> {
  try {
    const [data, signature] = token.split(".");
    if (!data || !signature) return false;
    const expectedSig = await hmacSha256Base64Url(secret, data);
    if (!timingSafeEqual(signature, expectedSig)) return false;
    // base64url decode payload via atob
    const padded = data.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "===".slice((padded.length + 3) % 4));
    const payload = JSON.parse(json);
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

async function isMustChangePasswordCookieValid(
  sessionToken: string,
  cookieValue: string,
): Promise<boolean> {
  try {
    const secret =
      process.env.SESSION_SECRET ||
      "development-secret-that-is-at-least-32-characters-long";
    const expected = await hmacSha256Base64Url(secret, `mcp:${sessionToken}`);
    return timingSafeEqual(cookieValue, expected);
  } catch {
    return false;
  }
}

// --- Middleware -------------------------------------------------------------

export async function middleware(req: NextRequest) {
  try {
    const { pathname } = req.nextUrl;

    // Handle CORS for extension API paths
    if (pathname.startsWith("/api/extension/")) {
      if (req.method === "OPTIONS") {
        return new NextResponse(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods":
              "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400",
          },
        });
      }
      const response = NextResponse.next();
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
      response.headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
      return response;
    }

    // Allow public paths
    if (isPublicPath(pathname)) {
      return NextResponse.next();
    }

    // E2E Test Auth Bypass
    const testSecret = process.env.E2E_TEST_SECRET;
    if (testSecret && testSecret.length >= 16) {
      const testToken = req.headers.get(TEST_AUTH_HEADER);
      if (
        testToken &&
        (await verifyTestTokenInMiddleware(testToken, testSecret))
      ) {
        return NextResponse.next();
      }
    }

    // Session-presence check (defense in depth — actual session validity is
    // confirmed against Mongo by getSession()/requireSession() in handlers,
    // because the Mongo driver can't run in the Edge runtime). If there's no
    // cookie at all on a non-public path, short-circuit immediately so we
    // don't waste a render cycle / DB hit on an obviously unauthenticated
    // request.
    const sessionToken = req.cookies.get(SESSION_COOKIE)?.value;
    if (!sessionToken) {
      // Dev convenience: when DEV_AUTO_LOGIN is on, the server-side
      // getSession() fabricates a session for the local engineer. Don't
      // short-circuit here or the dev experience breaks.
      const devAutoLogin =
        process.env.NODE_ENV !== "production" &&
        process.env.DEV_AUTO_LOGIN === "true";
      if (!devAutoLogin) {
        if (pathname.startsWith("/api/")) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        return redirectToLogin(req, pathname);
      }
      // Fall through with no session token; downstream handlers will
      // either match dev auto-login or return their own 401.
    }

    // Fast-path enforcement of the post-force-reset password-change gate via
    // a signed cookie (HMAC of the session token). This is an OPTIMIZATION,
    // not the source of truth: even if a determined user clears `mcp_flag`
    // in devtools, the page/API handler will still call requireSession(),
    // which loads `mustChangePassword` from Mongo and redirects to
    // /change-password. The cookie just lets us reject clearly-gated
    // requests before they hit any handler at all.
    const mcpCookie = req.cookies.get(MUST_CHANGE_PASSWORD_COOKIE)?.value;
    if (
      mcpCookie &&
      !isPasswordChangeAllowedPath(pathname) &&
      (await isMustChangePasswordCookieValid(sessionToken, mcpCookie))
    ) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Password change required", mustChangePassword: true },
          { status: 403 },
        );
      }
      const url = req.nextUrl.clone();
      url.pathname = "/change-password";
      url.search = "";
      return NextResponse.redirect(url);
    }

    return NextResponse.next();
  } catch (error) {
    console.error("Middleware error:", error);
    return NextResponse.next();
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
