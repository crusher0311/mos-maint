import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken } from "@/lib/extension-auth";
import { getDb } from "@/lib/db/drizzle";
import { snifferSessions } from "@/lib/db/schema/sniffer";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const MAX_CAPTURES = 500;
const MAX_BODY_LENGTH = 10000;
const MAX_URL_LENGTH = 2000;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "x-auth-token",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-csrf-token",
  "x-xsrf-token",
  "proxy-authorization",
]);

function redactHeaders(headers: any): Record<string, string> | null {
  if (!headers || typeof headers !== "object") return null;
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lk = String(key).toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(lk)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = String(value).substring(0, 500);
    }
  }
  return clean;
}

function redactBody(body: any): string | null {
  if (!body) return null;
  let str = typeof body === "string" ? body : JSON.stringify(body);
  str = str.substring(0, MAX_BODY_LENGTH);
  str = str.replace(
    /("(?:password|token|secret|api_key|apiKey|access_token|refresh_token|auth_token)":\s*")[^"]*"/gi,
    '$1[REDACTED]"'
  );
  return str;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  try {
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) {
      return NextResponse.json(
        { error: "Payload too large (max 5MB)" },
        { status: 413, headers: corsHeaders }
      );
    }

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: 401, headers: corsHeaders }
      );
    }

    if (auth.user.role !== "platform_admin") {
      return NextResponse.json(
        { error: "Platform admin access required" },
        { status: 403, headers: corsHeaders }
      );
    }

    const body = await request.json();
    const { captures, label, platform } = body;

    if (!captures || !Array.isArray(captures) || captures.length === 0) {
      return NextResponse.json(
        { error: "No captures provided" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (captures.length > MAX_CAPTURES) {
      return NextResponse.json(
        { error: `Too many captures (max ${MAX_CAPTURES})` },
        { status: 400, headers: corsHeaders }
      );
    }

    const sanitized = captures.map((c: any) => ({
      id: String(c.id || "").substring(0, 100),
      timestamp: typeof c.timestamp === "number" ? c.timestamp : Date.now(),
      platform: String(c.platform || "unknown").substring(0, 50),
      categories: Array.isArray(c.categories)
        ? c.categories.slice(0, 10).map((cat: any) => String(cat).substring(0, 30))
        : [],
      method: ALLOWED_METHODS.has(String(c.method || "").toUpperCase())
        ? String(c.method).toUpperCase()
        : "GET",
      url: String(c.url || "").substring(0, MAX_URL_LENGTH),
      path: String(c.path || "").substring(0, MAX_URL_LENGTH),
      requestHeaders: redactHeaders(c.requestHeaders),
      requestBody: redactBody(c.requestBody),
      responseStatus:
        typeof c.responseStatus === "number" ? c.responseStatus : null,
      responseBody: redactBody(c.responseBody),
      source: String(c.source || "").substring(0, 50),
    }));

    const db = getDb();
    const [inserted] = await db
      .insert(snifferSessions)
      .values({
        uploadedBy: String(auth.user._id),
        uploadedByEmail: auth.user.email || auth.user.emailLower || null,
        platform: platform ? String(platform).substring(0, 50) : null,
        label: label
          ? String(label).substring(0, 255)
          : `Capture session - ${new Date().toLocaleDateString()}`,
        captureCount: sanitized.length,
        captures: sanitized,
      })
      .returning({ id: snifferSessions.id });

    return NextResponse.json(
      {
        success: true,
        sessionId: inserted.id,
        captureCount: sanitized.length,
      },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    console.error("[Sniffer Upload] Error:", err);
    return NextResponse.json(
      { error: "Upload failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}
