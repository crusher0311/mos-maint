import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { emitShopErrorEvent } from "@/lib/alerts/shop-error-marker";
import {
  isIdentityPgCanonical,
  shadowWriteMongoIdentity,
} from "@/lib/db/wave4-write-mode";
import {
  findUserByExtensionToken,
  findUserById,
  updateUserExtensionTokenTimestamp,
  type MongoShapedUser,
} from "@/lib/data/repositories/pg/identity";
import {
  lookupExtensionSession,
  revokeExtensionSession,
  hasExtensionCapability,
  type ExtensionCapability,
  type ExtensionSessionPrincipal,
} from "@/lib/extension-session";
import { ObjectId, type Filter, type Document } from "mongodb";
import { lookupPolicy } from "@/lib/extension-route-policy";
import { isSuperAdmin } from "@/lib/super-admins";

/**
 * Stable error codes returned in the JSON body of every 401/503 from
 * `/api/extension/*`. Added in task #502 so the Chrome extension can tell
 * the difference between a terminal credential failure (`TOKEN_INVALID`,
 * `TOKEN_EXPIRED`, `TOKEN_MISSING`) — which after the retry budget is the
 * only thing that should ever cause the client to clear its saved token —
 * and a transient server-side problem (`AUTH_LOOKUP_FAILED`, 503) which
 * must NEVER trigger a logout. `SHOP_FORBIDDEN` covers the shop-scope
 * mismatch (still 401, but it's a route-level access problem, not a token
 * problem — re-auth would not fix it).
 *
 * Codes are additive: status codes did not change. Old clients that ignore
 * `code` see the same status + `error` they always did.
 */
export type ExtensionAuthCode =
  | "TOKEN_MISSING"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "TOKEN_REVOKED"
  | "SHOP_FORBIDDEN"
  | "PROVIDER_FORBIDDEN"
  | "CAPABILITY_REQUIRED"
  | "AUTH_LOOKUP_FAILED";

export interface ExtensionAuthResult {
  user: any | null;
  authorized: boolean;
  error: string | null;
  code?: ExtensionAuthCode;
  serverError?: boolean;
  status?: number;
  principal?: ExtensionSessionPrincipal;
}

export function isExtensionBearerRequest(request: NextRequest): boolean {
  const header = request.headers.get("Authorization") || "";
  return /^Bearer\s+ext(?:s)?_/i.test(header);
}

/**
 * Test seam — the smoke suite (`tests/extension-auth-401-codes.smoke.ts`)
 * overrides these to swap in fake Mongo / PG lookups without touching
 * the real DBs. Production code never assigns to this object.
 */
export const __deps: {
  getDb: typeof getDb;
  findUserByExtensionToken: typeof findUserByExtensionToken;
  findUserById: typeof findUserById;
  lookupExtensionSession: typeof lookupExtensionSession;
  revokeExtensionSession: typeof revokeExtensionSession;
  updateUserExtensionTokenTimestamp: typeof updateUserExtensionTokenTimestamp;
  isIdentityPgCanonical: typeof isIdentityPgCanonical;
} = {
  getDb,
  findUserByExtensionToken,
  findUserById,
  lookupExtensionSession,
  revokeExtensionSession,
  updateUserExtensionTokenTimestamp,
  isIdentityPgCanonical,
};

const MAX_TOKEN_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const EXTENSION_READ_ONLY_ROLES = new Set(["viewer", "read_only", "readonly"]);

export function capabilitiesForVerifiedUser(user: any): ExtensionCapability[] {
  const capabilities: ExtensionCapability[] = ["read", "shop_tool"];
  const role = String(user?.role || "").toLowerCase();
  const isAdmin =
    role === "platform_admin" ||
    user?.isPlatformAdmin === true ||
    isSuperAdmin(user?.email);
  if (isAdmin || (user?.readOnly !== true && !EXTENSION_READ_ONLY_ROLES.has(role))) {
    capabilities.push("write", "provider_action");
  }
  if (isAdmin) capabilities.push("admin");
  return capabilities;
}

export function isActiveExtensionUser(user: any): boolean {
  return (
    Boolean(user) &&
    user.disabled !== true &&
    user.isActive !== false &&
    user.active !== false &&
    user.deleted !== true &&
    user.isDeleted !== true &&
    user.deletedAt == null &&
    !["disabled", "deleted", "inactive", "suspended"].includes(
      String(user.status || "active").toLowerCase(),
    )
  );
}

/**
 * Enterprise auto-access. So that an enterprise OWNER/ADMIN no longer has to be
 * hand-added to every sibling location, we expand their accessible shops to
 * include EVERY shop that shares an `enterpriseId` with one of their
 * explicitly-assigned shops. The result is stashed on `user.accessibleShopIds`,
 * which `getUserShopIds` then folds in — so every extension route that gates on
 * `getUserShopIds` (or otherwise reads the user's shop list) picks it up with no
 * change of its own.
 *
 * Properties that keep this safe:
 *  - ADDITIVE only: it can never remove a shop a user already had.
 *  - role-gated: regular users (techs / service writers) are untouched, so the
 *    extra Mongo lookup only runs for the small owner/admin population.
 *    `platform_admin` already bypasses shop scoping everywhere, so it is skipped.
 *  - best-effort: any DB hiccup is swallowed and the user keeps their explicit
 *    `shopIds` (base access) rather than getting locked out.
 *
 * Mirrors the enterprise query used by the dashboard `GET /api/shops/list`: it
 * reads `enterpriseId` straight off the shop docs and reuses the value, so it is
 * agnostic to whether the field is stored as a string or an ObjectId.
 */
async function attachEnterpriseAccess(
  dbHandle: Awaited<ReturnType<typeof getDb>> | null,
  user: any,
): Promise<void> {
  try {
    const role = user?.role;
    if (role !== "owner" && role !== "admin") return;

    const base = getUserShopIds(user);
    if (base.length === 0) return;

    const db = dbHandle ?? (await __deps.getDb());

    // shopId is stored as a number in some docs and a string in others, so
    // match on both shapes (same defensive pattern as the dashboard routes).
    const baseLookup = base.flatMap((id) => {
      const num = Number(id);
      return Number.isFinite(num) ? [id, num] : [id];
    });

    const ownShops = await db
      .collection("shops")
      .find({ shopId: { $in: baseLookup } })
      .project({ enterpriseId: 1 })
      .toArray();

    const enterpriseIds = Array.from(
      new Set(
        ownShops
          .map((s: any) => s.enterpriseId)
          .filter((e: any) => e != null && e !== ""),
      ),
    );
    if (enterpriseIds.length === 0) return;

    const siblingShops = await db
      .collection("shops")
      .find({ enterpriseId: { $in: enterpriseIds } })
      .project({ shopId: 1 })
      .toArray();

    const expanded = new Set<string>(base);
    for (const s of siblingShops) {
      if (s?.shopId != null) expanded.add(String(s.shopId));
    }
    if (expanded.size > base.length) {
      user.accessibleShopIds = Array.from(expanded);
    }
  } catch (err) {
    console.warn(
      "[Extension Auth] enterprise access expansion failed (using base shopIds):",
      err,
    );
  }
}

export async function validateExtensionToken(
  request: NextRequest, 
  requiredShopId?: string
): Promise<ExtensionAuthResult> {
  let token: string | null = null;

  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  }

  if (!token) {
    token = request.nextUrl.searchParams.get("_token");
  }

  if (!token || (!token.startsWith("ext_") && !token.startsWith("exts_"))) {
    const hasAuthHeader = !!authHeader;
    const hasQueryToken = !!request.nextUrl.searchParams.get("_token");
    console.log(`[Extension Auth] No valid token: hasAuthHeader=${hasAuthHeader}, hasQueryToken=${hasQueryToken}, path=${request.nextUrl.pathname}`);
    emitShopErrorEvent({
      group: "EXT_AUTH_401",
      shopId: requiredShopId ?? null,
      status: 401,
      code: "TOKEN_MISSING",
      path: request.nextUrl.pathname,
      method: request.method,
    });
    return { user: null, authorized: false, error: "Missing authorization", code: "TOKEN_MISSING" };
  }

  // First-class sessions are canonical in Postgres and keep the bearer token
  // opaque: only a SHA-256 hash is stored. Legacy ext_ user-document tokens
  // are intentionally handled below during the bounded rollout window.
  if (token.startsWith("exts_")) {
    try {
      const lookup = await __deps.lookupExtensionSession(token);
      if (lookup.status !== "active") {
        const code: ExtensionAuthCode =
          lookup.status === "expired"
            ? "TOKEN_EXPIRED"
            : lookup.status === "revoked"
              ? "TOKEN_REVOKED"
              : "TOKEN_INVALID";
        return {
          user: null,
          authorized: false,
          error:
            lookup.status === "expired"
              ? "Token expired"
              : lookup.status === "revoked"
                ? "Token revoked"
                : "Invalid token",
          code,
        };
      }

      const principal = lookup.principal;
      let sessionUser: any;
      if (principal.assurance === "basic") {
        // Never trust persisted capability drift to elevate a Basic row.
        principal.capabilities =
          principal.provider === "tekmetric"
            ? ["read", "shop_tool"]
            : ["read"];
        // A Basic principal is deliberately not backed by a users row. It is
        // presented to the UI as a normal user while capability checks remain
        // authoritative for every mutation/admin decision.
        sessionUser = {
          _id: `basic:${principal.sessionId}`,
          id: `basic:${principal.sessionId}`,
          email: null,
          name: "Basic",
          role: "user",
          shopId: principal.shopId,
          shopIds: principal.shopId == null ? [] : [principal.shopId],
          isPlatformAdmin: false,
          readOnly: true,
        };
      } else {
        if (!principal.userId) {
          return {
            user: null,
            authorized: false,
            error: "Verified session has no user identity",
            code: "TOKEN_INVALID",
          };
        }
        if (__deps.isIdentityPgCanonical()) {
          sessionUser = await __deps.findUserById(principal.userId);
        } else {
          const mongo = await __deps.getDb();
          const idCandidates: (string | ObjectId)[] = [principal.userId];
          if (ObjectId.isValid(principal.userId)) {
            idCandidates.push(new ObjectId(principal.userId));
          }
          sessionUser = await mongo
            .collection("users")
            .findOne({ _id: { $in: idCandidates } } as Filter<Document>);
        }
        if (!sessionUser) {
          return {
            user: null,
            authorized: false,
            error: "Session user no longer exists",
            code: "TOKEN_INVALID",
          };
        }
        if (!isActiveExtensionUser(sessionUser)) {
          try {
            await __deps.revokeExtensionSession(principal.sessionId);
          } catch (error) {
            console.warn(
              "[Extension Auth] unable to revoke inactive-user session",
              error,
            );
          }
          return {
            user: null,
            authorized: false,
            error: "Session user is inactive",
            code: "TOKEN_REVOKED",
          };
        }

        // Verified sessions inherit the matched account's CURRENT authority.
        // Role/read-only changes therefore take effect immediately instead of
        // leaving stale write/admin claims valid until token expiry.
        principal.capabilities = capabilitiesForVerifiedUser(sessionUser);

        // Re-check assignment on every request so removing a user from a shop
        // takes effect without mutating or revoking the user record itself.
        const assigned = getUserShopIds(sessionUser);
        const platformAdmin =
          sessionUser.role === "platform_admin" ||
          sessionUser.isPlatformAdmin === true;
        if (
          principal.shopId == null ||
          (!platformAdmin && !assigned.includes(String(principal.shopId)))
        ) {
          return {
            user: sessionUser,
            authorized: false,
            error: "Unauthorized shop access",
            code: "SHOP_FORBIDDEN",
            status: 403,
            principal,
          };
        }

        // Downstream legacy routes sometimes read user.shopId/shopIds directly
        // instead of getUserShopIds(). Keep the matched account's role and
        // preferences, but present only the session-bound shop to route code.
        sessionUser = {
          ...sessionUser,
          shopId: principal.shopId,
          shopIds: [principal.shopId],
          accessibleShopIds: [principal.shopId],
        };
      }

      sessionUser.extensionPrincipal = principal;
      if (
        requiredShopId &&
        String(principal.shopId) !== String(requiredShopId)
      ) {
        return {
          user: sessionUser,
          authorized: false,
          error: "Session is scoped to a different shop",
          code: "SHOP_FORBIDDEN",
          status: 403,
          principal,
        };
      }

      const authorizedResult: ExtensionAuthResult = {
        user: sessionUser,
        authorized: true,
        error: null,
        principal,
      };
      return enforceExtensionRoutePolicy(request, authorizedResult);
    } catch (err) {
      console.error("[Extension Session] lookup failed:", err);
      return {
        user: null,
        authorized: false,
        error: "Server error",
        code: "AUTH_LOOKUP_FAILED",
        serverError: true,
      };
    }
  }

  // W4 cutover (#346): PG-canonical read when the flag is on.
  // Both branches return Mongo-shaped user docs. PG path uses the
  // typed `MongoShapedUser`; Mongo path is the raw driver shape and
  // is read with the same accessors below.
  const pgCanonical = __deps.isIdentityPgCanonical();
  let db: Awaited<ReturnType<typeof getDb>> | null = null;
  let user:
    | MongoShapedUser
    | { _id?: unknown; id?: unknown; extensionTokenCreatedAt?: Date; email?: string; shopId?: unknown; role?: string }
    | null = null;
  // Multi-device concurrent-sessions support: a user may have several active
  // tokens at once (one per device/tab). Tokens live both in the legacy
  // `extensionToken` scalar (most-recent) AND in `extensionTokens[]`
  // (history, capped + pruned by /api/extension/auth). Every Mongo lookup
  // accepts either shape so a tab whose token is no longer the most recent
  // one keeps working until its own 30-day TTL elapses or the user
  // explicitly logs that device out. Locked in by
  // `tests/extension-auth-multi-token.smoke.ts`.
  const mongoTokenFilter: Filter<Document> = {
    $or: [
      { extensionToken: token },
      { extensionTokens: { $elemMatch: { token } } },
    ],
  };
  try {
    if (pgCanonical) {
      user = await __deps.findUserByExtensionToken(token);
      // Task #502 safety net: while the PG identity cutover is still
      // settling, a row that exists in Mongo `users.extensionToken` but
      // hasn't propagated into PG yet would otherwise log the user out
      // mid-shift. Fall back to a Mongo read on PG-miss and log it so
      // we can quantify the drift. This is intentionally additive — the
      // cutover stays in place; this is just a "don't bounce real
      // customers" net. The same fallback now also catches multi-device
      // tokens that live in `extensionTokens[]` but not in the PG
      // single-token column.
      if (!user) {
        try {
          db = await __deps.getDb();
          const mongoUser = await db
            .collection("users")
            .findOne(mongoTokenFilter);
          if (mongoUser) {
            const maskedEmail = mongoUser.email
              ? String(mongoUser.email).replace(/(.{2}).*(@.*)/, "$1***$2")
              : "unknown";
            console.warn(
              `[Extension Auth] pg_miss_mongo_hit user=${maskedEmail} path=${request.nextUrl.pathname}`,
            );
            user = mongoUser as any;
          }
        } catch (mErr) {
          console.error("[Extension Auth] pg_miss mongo fallback failed:", mErr);
        }
      }
    } else {
      db = await __deps.getDb();
      user = await db.collection("users").findOne(mongoTokenFilter);
    }
  } catch (err) {
    console.error("[Extension Auth] Token lookup failed:", err);
    emitShopErrorEvent({
      group: "EXT_5XX",
      shopId: requiredShopId ?? null,
      status: 503,
      code: "AUTH_LOOKUP_FAILED",
      path: request.nextUrl.pathname,
      method: request.method,
      message: (err as any)?.message,
    });
    return {
      user: null,
      authorized: false,
      error: "Server error",
      code: "AUTH_LOOKUP_FAILED",
      serverError: true,
    };
  }

  if (!user) {
    console.log(`[Extension Auth] Token not found in DB, path=${request.nextUrl.pathname}`);
    emitShopErrorEvent({
      group: "EXT_AUTH_401",
      shopId: requiredShopId ?? null,
      status: 401,
      code: "TOKEN_INVALID",
      path: request.nextUrl.pathname,
      method: request.method,
    });
    return { user: null, authorized: false, error: "Invalid token", code: "TOKEN_INVALID" };
  }

  // Resolve the createdAt for *this specific* token. If the presented token
  // is the user's most-recent one (i.e. equal to the legacy `extensionToken`
  // scalar), use `extensionTokenCreatedAt`. Otherwise look it up in
  // `extensionTokens[]` so older concurrent-device tokens have their own
  // independent TTL — without this, a stale entry would inherit the latest
  // login's createdAt and never expire even if it had been unused for weeks.
  const matchedTokenEntry: { token: string; createdAt?: Date | string; lastUsedAt?: Date | string } | null =
    (user as any).extensionToken === token
      ? null
      : (Array.isArray((user as any).extensionTokens)
        ? (user as any).extensionTokens.find((t: any) => t?.token === token) ?? null
        : null);
  const effectiveCreatedAt: Date | null = matchedTokenEntry?.createdAt
    ? new Date(matchedTokenEntry.createdAt)
    : (user.extensionTokenCreatedAt ? new Date(user.extensionTokenCreatedAt) : null);

  if (effectiveCreatedAt) {
    const tokenAge = Date.now() - effectiveCreatedAt.getTime();

    if (tokenAge > MAX_TOKEN_AGE_MS) {
      const maskedEmail = user.email ? user.email.replace(/(.{2}).*(@.*)/, '$1***$2') : 'unknown';
      console.log(`[Extension Auth] Token expired: user=${maskedEmail}, age=${Math.round(tokenAge / 86400000)}d, max=${MAX_TOKEN_AGE_MS / 86400000}d, path=${request.nextUrl.pathname}`);
      emitShopErrorEvent({
        group: "EXT_AUTH_401",
        shopId: requiredShopId ?? (user as any)?.shopId ?? null,
        status: 401,
        code: "TOKEN_EXPIRED",
        path: request.nextUrl.pathname,
        method: request.method,
      });
      return { user: null, authorized: false, error: "Token expired", code: "TOKEN_EXPIRED" };
    }

    // Compatibility is deliberately bounded: legacy user-document tokens are
    // readable until their original 30-day expiry, but validation never
    // renews that timestamp. New logins rotate onto revocable exts_ sessions.
  }

  // Enterprise auto-access: expand owner/admin reach to all shops sharing their
  // enterpriseId (additive, best-effort). Runs once here so the requiredShopId
  // check below AND every downstream getUserShopIds() caller see the same set.
  await attachEnterpriseAccess(db, user);

  if (requiredShopId) {
    const accessibleShopIds = getUserShopIds(user);
    
    const hasAccess = accessibleShopIds.includes(requiredShopId);
    
    const isPlatformAdmin = user.role === "platform_admin";
    
    if (!hasAccess && !isPlatformAdmin) {
      console.warn(`[Extension Auth] Unauthorized shop access: user ${user.email} (shops ${accessibleShopIds.join(",")}) tried shop ${requiredShopId}`);
      emitShopErrorEvent({
        group: "EXT_AUTH_401",
        shopId: requiredShopId,
        status: 401,
        code: "SHOP_FORBIDDEN",
        path: request.nextUrl.pathname,
        method: request.method,
      });
      return { user, authorized: false, error: "Unauthorized shop access", code: "SHOP_FORBIDDEN" };
    }
  }

  const legacyPrincipal: ExtensionSessionPrincipal = {
    sessionId: `legacy:${String((user as any).id ?? (user as any)._id ?? "unknown")}`,
    userId: String((user as any).id ?? (user as any)._id ?? ""),
    assurance: "verified",
    capabilities: capabilitiesForVerifiedUser(user),
    expiresAt:
      effectiveCreatedAt != null
        ? new Date(effectiveCreatedAt.getTime() + MAX_TOKEN_AGE_MS)
        : new Date(Date.now() + MAX_TOKEN_AGE_MS),
    isLegacy: true,
  };
  (user as any).extensionPrincipal = legacyPrincipal;
  return enforceExtensionRoutePolicy(request, {
    user,
    authorized: true,
    error: null,
    principal: legacyPrincipal,
  });
}

export function enforceExtensionRoutePolicy(
  request: Pick<NextRequest, "method" | "nextUrl">,
  auth: ExtensionAuthResult,
): ExtensionAuthResult {
  const pathname = request.nextUrl.pathname;
  const tiers = lookupPolicy(pathname, request.method);
  if (!tiers) {
    // Only the extension namespace is fail-closed for an unknown route.
    // A small, explicitly linted set of extension-backed routes outside the
    // namespace is also in POLICY_MAP and reaches the checks below.
    if (!pathname.startsWith("/api/extension/")) return auth;
    console.error(
      `[Extension Auth] no capability policy for ${request.method} ${pathname}`,
    );
    return {
      ...auth,
      authorized: false,
      error: "Extension route is not authorized",
      code: "CAPABILITY_REQUIRED",
      status: 403,
    };
  }
  if (tiers.includes("public") || tiers.includes("preflight")) return auth;
  const required: ExtensionCapability[] = [];
  if (tiers.includes("read")) required.push("read");
  if (tiers.includes("shop_tool")) required.push("shop_tool");
  if (tiers.includes("write")) required.push("write");
  if (tiers.includes("provider_action")) required.push("provider_action");
  if (tiers.includes("admin")) required.push("admin");
  return requireExtensionCapabilities(auth, required) ?? auth;
}

export function getAuthErrorStatus(auth: ExtensionAuthResult): number {
  if (auth.serverError) return 503;
  if (auth.status) return auth.status;
  if (
    auth.code === "CAPABILITY_REQUIRED" ||
    auth.code === "PROVIDER_FORBIDDEN"
  ) {
    return 403;
  }
  return 401;
}

/**
 * Build the JSON body to return for a failed `validateExtensionToken`
 * result. Always includes `error` and `code` so the extension can branch
 * on terminal vs transient failures (task #502). Extra fields can be
 * merged in by routes that have their own response shape (e.g.
 * `{ ok: false, ... }`).
 */
export function buildAuthErrorBody(
  auth: ExtensionAuthResult,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    error: auth.error || "Unauthorized",
    code: auth.code ?? (auth.serverError ? "AUTH_LOOKUP_FAILED" : "TOKEN_INVALID"),
    ...(extra ?? {}),
  };
}

export function requireExtensionCapabilities(
  auth: Pick<ExtensionAuthResult, "user" | "principal">,
  required: ExtensionCapability[],
): ExtensionAuthResult | null {
  const principal =
    auth.principal ??
    (auth.user?.extensionPrincipal as ExtensionSessionPrincipal | undefined);
  const missing = required.filter(
    (capability) => !hasExtensionCapability(principal, capability),
  );
  if (missing.length === 0) return null;
  return {
    user: auth.user ?? null,
    authorized: false,
    error:
      principal?.assurance === "basic"
        ? "Verify your MOS.Tools account to make changes"
        : "This session does not have the required capability",
    code: "CAPABILITY_REQUIRED",
    status: 403,
    principal,
  };
}

export function getExtensionPrincipal(user: any): ExtensionSessionPrincipal | undefined {
  return user?.extensionPrincipal as ExtensionSessionPrincipal | undefined;
}

export function requireExtensionPrincipalScope(
  auth: Pick<ExtensionAuthResult, "user" | "principal">,
  scope: { shopId: string | number; provider?: string | null },
): ExtensionAuthResult | null {
  const principal =
    auth.principal ??
    (auth.user?.extensionPrincipal as ExtensionSessionPrincipal | undefined);
  if (!principal || principal.isLegacy) return null;
  if (String(principal.shopId) !== String(scope.shopId)) {
    return {
      user: auth.user ?? null,
      authorized: false,
      error: "Session is scoped to a different shop",
      code: "SHOP_FORBIDDEN",
      status: 403,
      principal,
    };
  }
  if (
    scope.provider &&
    String(principal.provider).toLowerCase() !==
      String(scope.provider).toLowerCase().replace(/^shop[-_]ware$/, "shopware")
  ) {
    return {
      user: auth.user ?? null,
      authorized: false,
      error: "Session is scoped to a different provider",
      code: "PROVIDER_FORBIDDEN",
      status: 403,
      principal,
    };
  }
  return null;
}

export function getUserShopIds(user: any): string[] {
  const principal = user?.extensionPrincipal as ExtensionSessionPrincipal | undefined;
  if (principal && !principal.isLegacy) {
    return principal.shopId == null ? [] : [String(principal.shopId)];
  }
  const shopIds: string[] = [];
  
  if (user.shopId) {
    shopIds.push(user.shopId.toString());
  }
  
  if (user.shopIds && Array.isArray(user.shopIds)) {
    for (const id of user.shopIds) {
      const strId = id.toString();
      if (!shopIds.includes(strId)) {
        shopIds.push(strId);
      }
    }
  }

  // Enterprise auto-access: owners/admins get every shop sharing their
  // enterpriseId, computed once in validateExtensionToken and stashed here.
  // Purely additive — only ever widens the set. Role-gated as defense-in-depth
  // so a stray `accessibleShopIds` on a non-owner doc can never widen access.
  if (
    (user.role === "owner" || user.role === "admin") &&
    user.accessibleShopIds &&
    Array.isArray(user.accessibleShopIds)
  ) {
    for (const id of user.accessibleShopIds) {
      const strId = id.toString();
      if (!shopIds.includes(strId)) {
        shopIds.push(strId);
      }
    }
  }
  
  return shopIds;
}
