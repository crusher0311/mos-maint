// gate-exempt: public proof exchange establishes auth; it cannot use a prior extension gate
import crypto from "node:crypto";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import {
  issueBasicExtensionSession,
  issueExtensionSession,
  lookupExtensionSession,
  revokeExtensionSession,
} from "@/lib/extension-session";
import { verifyProviderSessionProof } from "@/lib/extension-provider-proof";
import {
  listExtensionBootstrapCandidateUsers,
  matchExistingExtensionUser,
} from "@/lib/extension-bootstrap-user";
import { capabilitiesForVerifiedUser } from "@/lib/extension-auth";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const MAX_BODY_BYTES = 12 * 1024;
const BOOTSTRAP_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export const __deps = {
  verifyProviderSessionProof,
  listCandidateUsers: listExtensionBootstrapCandidateUsers,
  issueBasicExtensionSession,
  issueExtensionSession,
  lookupExtensionSession,
  revokeExtensionSession,
  rateLimit: async (opts: {
    id: string;
    limit: number;
    windowSeconds: number;
  }) => (await import("@/lib/rate")).rateLimit(opts),
  now: () => Date.now(),
};

function clientIp(request: Request): string {
  const forwarded = (request.headers.get("x-forwarded-for") || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  // The nearest trusted reverse proxy appends the socket address at the end.
  // Never trust the first value, which a direct client can pre-populate.
  return forwarded.at(-1) || "unknown";
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(exts_[A-Za-z0-9_-]+)$/i);
  return match?.[1] ?? null;
}

async function revokeSupersededSession(
  request: Request,
  nextUserId?: string,
): Promise<void> {
  const token = bearerToken(request);
  if (!token) return;
  try {
    const prior = await __deps.lookupExtensionSession(token);
    if (
      prior.status === "active" &&
      (prior.principal.assurance === "basic" ||
        (nextUserId != null && prior.principal.userId === nextUserId))
    ) {
      await __deps.revokeExtensionSession(prior.principal.sessionId);
    }
  } catch {
    // The new token is already valid. A failed best-effort revoke must not
    // disclose or destroy the successful exchange.
  }
}

function publicOutcome(
  outcome:
    | "unsupported"
    | "unavailable"
    | "verification_needed"
    | "rate_limited"
    | "error",
  status: number,
  reason?: string,
) {
  return NextResponse.json(
    {
      ok: false,
      outcome,
      reason:
        outcome === "unsupported" || outcome === "unavailable"
          ? reason
          : outcome,
    },
    { status, headers: corsHeaders },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _POST(request: NextRequest) {
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return publicOutcome("verification_needed", 413);
    }

    const throttle = await __deps.rateLimit({
      id: `extension-bootstrap:${clientIp(request)}`,
      limit: 12,
      windowSeconds: 60,
    });
    if (!throttle.allowed) {
      console.info("[Extension Bootstrap] outcome=rate_limited");
      return publicOutcome("rate_limited", 429);
    }

    const body = await request.json();
    const proofFingerprint = crypto
      .createHash("sha256")
      .update(
        [
          String(body?.provider || "").toLowerCase(),
          String(body?.smsShopId || ""),
          typeof body?.proof?.token === "string" ? body.proof.token : "no-proof",
        ].join("\0"),
      )
      .digest("hex");
    const proofThrottle = await __deps.rateLimit({
      id: `extension-bootstrap-attempt:${proofFingerprint}`,
      limit: 4,
      windowSeconds: 60,
    });
    if (!proofThrottle.allowed) {
      console.info("[Extension Bootstrap] outcome=rate_limited scope=proof");
      return publicOutcome("rate_limited", 429);
    }
    const proof = await __deps.verifyProviderSessionProof({
      provider: body?.provider,
      smsShopId: String(body?.smsShopId ?? ""),
      proof: body?.proof,
    });
    if (proof.status !== "verified") {
      // `unsupported` (provider has no proof mechanism) and `unavailable`
      // (shop not resolvable/allowlisted — e.g. a brand-new shop) are normal
      // "sign in with MOS.Tools instead" outcomes, not verification failures.
      const outcome =
        proof.status === "unsupported"
          ? ("unsupported" as const)
          : proof.status === "unavailable"
            ? ("unavailable" as const)
            : ("verification_needed" as const);
      console.info(
        `[Extension Bootstrap] outcome=${outcome} provider=${proof.provider}`,
      );
      return publicOutcome(
        outcome,
        outcome === "verification_needed" ? 401 : 200,
        outcome === "verification_needed" ? undefined : proof.reason,
      );
    }

    const candidates = await __deps.listCandidateUsers({
      employee: proof.employee,
    });
    const matchedUser = matchExistingExtensionUser({
      users: candidates,
      provider: proof.provider,
      smsShopId: proof.smsShopId,
      mosShopId: proof.shopId,
      employee: proof.employee,
    });
    const expiresAt = new Date(__deps.now() + BOOTSTRAP_SESSION_TTL_MS);
    const matchedUserId = matchedUser
      ? String(matchedUser._id ?? matchedUser.id)
      : undefined;
    if (matchedUser && !matchedUserId) {
      throw new Error("Matched extension user has no stable id");
    }

    // Provider roles are never read. A matched user receives only the
    // authority already stored on their existing MOS account.
    const authority = matchedUser
      ? capabilitiesForVerifiedUser(matchedUser)
      : ["read"];
    const issued = matchedUser
      ? await __deps.issueExtensionSession({
          shopId: proof.shopId,
          provider: proof.provider,
          assurance: "verified",
          userId: matchedUserId,
          isAdmin: authority.includes("admin"),
          canWrite: authority.includes("write"),
          expiresAt,
        })
      : await __deps.issueBasicExtensionSession({
          shopId: proof.shopId,
          provider: proof.provider,
          expiresAt,
        });

    await revokeSupersededSession(request, matchedUserId);

    const user = matchedUser
      ? {
          id: matchedUserId,
          name: matchedUser.name || matchedUser.email,
          email: matchedUser.email,
          role: matchedUser.role,
          shopId: proof.shopId,
          shopIds: [proof.shopId],
          isPlatformAdmin:
            matchedUser.isPlatformAdmin === true ||
            matchedUser.role === "platform_admin",
          defaultExtensionTab: matchedUser.defaultExtensionTab || null,
          shopwareAddMode: matchedUser.shopwareAddMode || null,
        }
      : {
          id: `basic:${issued.principal.sessionId}`,
          name: "Basic",
          email: null,
          role: "user",
          shopId: proof.shopId,
          shopIds: [proof.shopId],
          isPlatformAdmin: false,
          readOnly: true,
        };
    const shop = {
      shopId: proof.shopId,
      name: proof.shopName,
      provider: proof.provider,
      smsShopId: proof.smsShopId,
      integrations: [proof.provider],
      writeProvider: null,
    };
    const outcome = matchedUser ? "matched_user" : "basic";
    // Privacy-safe rollout signal: no token, email, subject, or provider
    // response data is logged.
    console.info(
      `[Extension Bootstrap] outcome=${outcome} shop=${proof.shopId} provider=${proof.provider}`,
    );
    return NextResponse.json(
      {
        ok: true,
        outcome,
        token: issued.token,
        assurance: issued.principal.assurance,
        capabilities: issued.principal.capabilities,
        expiresAt: issued.principal.expiresAt.toISOString(),
        session: {
          assurance: issued.principal.assurance,
          capabilities: issued.principal.capabilities,
          shopId: issued.principal.shopId,
          provider: issued.principal.provider,
          smsShopId: proof.smsShopId,
          expiresAt: issued.principal.expiresAt.toISOString(),
        },
        user,
        shops: [shop],
      },
      { headers: corsHeaders },
    );
  } catch {
    console.error("[Extension Bootstrap] outcome=error");
    return publicOutcome("error", 503);
  }
}

export const POST = withExtensionErrorMarker(_POST as any);