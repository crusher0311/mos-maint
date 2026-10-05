import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getUserShopIds, buildAuthErrorBody, getAuthErrorStatus, type ExtensionAuthResult } from "./extension-auth";
import { findShopBySmsIdDetailed } from "./extension-shop-lookup";
import { issueExtensionSession, hashExtensionSessionToken } from "./extension-session";

export const __deps = { validateExtensionToken, findShopBySmsIdDetailed, issueExtensionSession };
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
export async function switchLocation(request: NextRequest, validatedAuth?: ExtensionAuthResult) {
  const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers: corsHeaders });
  try {
    const auth = validatedAuth ?? await __deps.validateExtensionToken(request);
    if (!auth.authorized) return reply(buildAuthErrorBody(auth), getAuthErrorStatus(auth));
    const principal = auth.principal;
    // Bootstrap, Basic, legacy and derived sessions cannot renew authentication.
    // Pre-migration sessions need a one-time explicit sign-in to record provenance.
    if (!principal || principal.assurance !== "verified" || principal.isLegacy ||
        principal.parentTokenHash || !["password", "login_code"].includes(principal.authenticationMethod || "")) {
      return reply({ code: "EXPLICIT_LOGIN_REQUIRED", error: "Sign in to MOS once to enable Tekmetric location switching." }, 403);
    }
    const body = await request.json();
    if (body.provider !== "tekmetric" || !/^[1-9]\d*$/.test(String(body.smsShopId || ""))) {
      return reply({ code: "CONTEXT_REQUIRED", error: "A current Tekmetric location is required." }, 400);
    }
    // Match the authenticated identity only. Same email and enterprise membership
    // are not employee assignments; duplicate user documents are not merged here.
    const target = await __deps.findShopBySmsIdDetailed(String(body.smsShopId), {
      providerHint: "tekmetric",
      providerHintIsAuthoritative: true,
      userShopIds: getUserShopIds(auth.accountUser).map(Number),
      isPlatformAdmin: auth.accountUser?.role === "platform_admin" || auth.accountUser?.isPlatformAdmin === true,
    });
    if (target.status !== "resolved") {
      const failures = {
        not_found: [404, "SHOP_UNLINKED", "This Tekmetric location isn't linked in MOS. Printing is blocked."],
        access_denied: [403, "SHOP_FORBIDDEN", "This Tekmetric location is linked in MOS, but your account does not have access."],
        conflict: [409, "SHOP_MAPPING_CONFLICT", "This Tekmetric location has conflicting MOS mappings. Ask a platform admin to repair them."],
      } as const;
      const [status, code, error] = failures[target.status];
      return reply({ code, error }, status);
    }
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const issued = await __deps.issueExtensionSession({
      shopId: target.mosShopId, provider: "tekmetric", assurance: "verified",
      userId: principal.userId, expiresAt: new Date(Math.min(principal.expiresAt.getTime(), Date.now() + 5 * 60_000)),
      parentTokenHash: hashExtensionSessionToken(token),
      canWrite: principal.capabilities.includes("write"),
      isAdmin: principal.capabilities.includes("admin"),
    });
    return reply({ token: issued.token, shopId: target.mosShopId, smsShopId: String(body.smsShopId),
      provider: "tekmetric", expiresAt: issued.principal.expiresAt.toISOString() }, 200);
  } catch {
    return reply({ code: "LOCATION_LOOKUP_FAILED", error: "Tekmetric location access could not be checked. Please try again; nothing was printed." }, 503);
  }
}
