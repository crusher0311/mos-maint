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
  if (pathname.startsWith("/api/e2e/")) return true;
  if (pathname.startsWith("/api/extension/")) return true;
  if (pathname.startsWith("/api/cron/")) return true;
  if (pathname.startsWith("/api/platform-admin/log-stream")) return true;
  if (pathname.startsWith("/api/docs")) return true;
  if (pathname.startsWith("/report/")) return true;
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
    
    // Handle CORS for extension API paths
    if (pathname.startsWith("/api/extension/")) {
      if (req.method === "OPTIONS") {
        return new NextResponse(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400",
          },
        });
      }
      const response = NextResponse.next();
      response.headers.set("Access-Control-Allow-Origin", "*");
      response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
      if (testToken && verifyTestTokenInMiddleware(testToken, testSecret)) {
        return NextResponse.next();
      }
    }

    // Check for session token
    const sid = req.cookies.get(SESSION_COOKIE)?.value;
    if (!sid) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return redirectToLogin(req, pathname);
    }

    // Validate session in database for protected routes
    const isValidSession = await validateSession(sid);
    if (!isValidSession) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Session expired" }, { status: 401 });
      }
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

