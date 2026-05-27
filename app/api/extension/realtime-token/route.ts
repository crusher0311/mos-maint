// gate-exempt: pre-feature plumbing — issues short-lived Supabase Realtime
// credentials for the Detect Dog overlay. Returns 503 (not 4xx) when the
// feature is disabled so the extension treats it as "fall back to polling".
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus , buildAuthErrorBody } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { isVhiRealtimeEnabled } from "@/lib/realtime/broadcast-vhi";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Mint a Supabase-compatible HS256 JWT scoped to a single shop. The
 * matching RLS policy on `realtime.messages` MUST restrict the topic to
 * `vhi:{shop_id}:%` using `auth.jwt() ->> 'shop_id'`. Example:
 *
 *   create policy "vhi shop scope" on realtime.messages
 *     for select using (
 *       extension = 'broadcast'
 *       and topic like 'vhi:' || (auth.jwt() ->> 'shop_id') || ':%'
 *     );
 *
 * Without that policy a token would be over-broad. Server-side broadcasts
 * use the service role key and bypass RLS so they always land.
 */
function signSupabaseJwt(shopId: number, jwtSecret: string): { token: string; expiresAt: number } {
  const header = { alg: "HS256", typ: "JWT" };
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;
  const payload = {
    role: "authenticated",
    sub: `mos-ext-shop-${shopId}`,
    shop_id: String(shopId),
    iat: issuedAt,
    exp: expiresAt,
  };
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(
    crypto.createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest()
  );
  return { token: `${head}.${body}.${sig}`, expiresAt };
}

export async function POST(request: NextRequest) {
  try {
    if (!isVhiRealtimeEnabled()) {
      return NextResponse.json(
        { error: "realtime disabled", reason: "feature_flag_off" },
        { status: 503, headers: corsHeaders }
      );
    }

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey =
      process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const supabaseJwtSecret = process.env.SUPABASE_JWT_SECRET;
    if (!supabaseUrl || !supabaseAnonKey || !supabaseJwtSecret) {
      return NextResponse.json(
        { error: "realtime not configured", reason: "missing_env" },
        { status: 503, headers: corsHeaders }
      );
    }

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(
        buildAuthErrorBody(auth),
        { status: getAuthErrorStatus(auth), headers: corsHeaders }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { provider, smsShopId } = body as { provider?: string; smsShopId?: string | number };

    if (!provider || !smsShopId) {
      return NextResponse.json(
        { error: "provider and smsShopId are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const userShopIds = getUserShopIds(auth.user).map((id) => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    const shopResult = await findShopBySmsId(String(smsShopId), {
      userShopIds,
      isPlatformAdmin,
      providerHint: provider,
    });
    if (!shopResult) {
      return NextResponse.json(
        { error: "Shop not found or access denied" },
        { status: 403, headers: corsHeaders }
      );
    }

    const mosShopId = Number(shopResult.mosShopId);
    const { token, expiresAt } = signSupabaseJwt(mosShopId, supabaseJwtSecret);

    return NextResponse.json(
      {
        ok: true,
        supabaseUrl,
        supabaseAnonKey,
        token,
        shopId: mosShopId,
        topicPrefix: `vhi:${mosShopId}:`,
        expiresAt,
      },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    console.error("[Extension Realtime Token] Error:", err?.message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: corsHeaders }
    );
  }
}
