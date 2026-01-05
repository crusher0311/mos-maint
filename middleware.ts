// middleware.ts
import { NextResponse, NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { createHmac } from "crypto";

const PUBLIC_PATHS = new Set(["/", "/login", "/forgot", "/reset", "/setup", "/api/auth/login", "/api/auth/forgot", "/api/auth/reset", "/api/auth/complete-setup", "/api/auth/setup"]);
const SESSION_COOKIE = "session_token";
const TEST_AUTH_HEADER = "x-test-auth";

function isPublicPath(pathname: string) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith("/api/webhooks/")) return true;
  if (pathname.startsWith("/api/ping")) return true;
  if (pathname.startsWith("/api/e2e/")) return true; // e2e test endpoints
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico" || pathname === "/robots.txt" || pathname === "/sitemap.xml") return true;
  return false;
}

function verifyTestTokenInMiddleware(token: string, secret: string): boolean {
  try {
    const [data, signature] = token.split(".");
    if (!data || !signature) return false;
    const expectedSig = createHmac("sha256", secret).update(data).digest("base64url");
    if (signature !== expectedSig) return false;
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

async function validateSession(token: string): Promise<boolean> {
  try {
    const db = await getDb();
    const session = await db.collection("sessions").findOne({
      token,
      expiresAt: { $gt: new Date() },
    });
    return !!session;
  } catch (error) {
    console.error("Session validation error:", error);
    return false;
  }
}

export async function middleware(req: NextRequest) {
  try {
    const { pathname } = req.nextUrl;
    
    // Allow public paths
    if (isPublicPath(pathname)) {
      return NextResponse.next();
    }

    // E2E Test Auth Bypass
    const testSecret = process.env.E2E_TEST_SECRET;
    if (testSecret && testSecret.length >= 16) {
      const testToken = req.headers.get(TEST_AUTH_HEADER);
      if (testToken && verifyTestTokenInMiddleware(testToken, testSecret)) {
        return NextResponse.next();
      }
    }

    // Check for session token
    const sid = req.cookies.get(SESSION_COOKIE)?.value;
    if (!sid) {
      return redirectToLogin(req, pathname);
    }

    // Validate session in database for protected routes
    const isValidSession = await validateSession(sid);
    if (!isValidSession) {
      const response = redirectToLogin(req, pathname);
      response.cookies.delete(SESSION_COOKIE);
      return response;
    }

    return NextResponse.next();
  } catch (error) {
    console.error("Middleware error:", error);
    return NextResponse.next();
  }
}

function redirectToLogin(req: NextRequest, pathname: string) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
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

