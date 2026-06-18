import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
import { emitShopErrorEvent } from "@/lib/alerts/shop-error-marker";
import {
  isIdentityPgCanonical,
  shadowWriteMongoIdentity,
} from "@/lib/db/wave4-write-mode";
import {
  findUserByExtensionToken,
  updateUserExtensionTokenTimestamp,
  type MongoShapedUser,
} from "@/lib/data/repositories/pg/identity";

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
  | "SHOP_FORBIDDEN"
  | "AUTH_LOOKUP_FAILED";

export interface ExtensionAuthResult {
  user: any | null;
  authorized: boolean;
  error: string | null;
  code?: ExtensionAuthCode;
  serverError?: boolean;
}

/**
 * Test seam — the smoke suite (`tests/extension-auth-401-codes.smoke.ts`)
 * overrides these to swap in fake Mongo / PG lookups without touching
 * the real DBs. Production code never assigns to this object.
 */
export const __deps: {
  getDb: typeof getDb;
  findUserByExtensionToken: typeof findUserByExtensionToken;
  updateUserExtensionTokenTimestamp: typeof updateUserExtensionTokenTimestamp;
  isIdentityPgCanonical: typeof isIdentityPgCanonical;
} = {
  getDb,
  findUserByExtensionToken,
  updateUserExtensionTokenTimestamp,
  isIdentityPgCanonical,
};

const MAX_TOKEN_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // refresh after 7 days of use

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

  if (!token || !token.startsWith("ext_")) {
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

  // W4 cutover (#346): PG-canonical read when the flag is on.
  // Both branches return Mongo-shaped user docs. PG path uses the
  // typed `MongoShapedUser`; Mongo path is the raw driver shape and
  // is read with the same accessors below.
  const pgCanonical = __deps.isIdentityPgCanonical();
  let db: Awaited<ReturnType<typeof getDb>> | null = null;
  let user:
    | MongoShapedUser
    | { _id?: unknown; id?: unknown; extensionTokenCreatedAt?: Date; email?: string; shopId?: unknown }
    | null = null;
  // Multi-device concurrent-sessions support: a user may have several active
  // tokens at once (one per device/tab). Tokens live both in the legacy
  // `extensionToken` scalar (most-recent) AND in `extensionTokens[]`
  // (history, capped + pruned by /api/extension/auth). Every Mongo lookup
  // accepts either shape so a tab whose token is no longer the most recent
  // one keeps working until its own 30-day TTL elapses or the user
  // explicitly logs that device out. Locked in by
  // `tests/extension-auth-multi-token.smoke.ts`.
  const mongoTokenFilter = {
    $or: [
      { extensionToken: token },
      { extensionTokens: { $elemMatch: { token } } },
    ],
  } as const;
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

    if (tokenAge > TOKEN_REFRESH_THRESHOLD_MS) {
      const ts = new Date();
      try {
        if (matchedTokenEntry) {
          // Refresh only the per-device entry — don't touch the scalar
          // `extensionToken`/`extensionTokenCreatedAt`, which belong to a
          // different (newer) device's session.
          if (!db) db = await __deps.getDb();
          await db.collection("users").updateOne(
            { _id: user._id ?? user.id },
            { $set: { "extensionTokens.$[t].lastUsedAt": ts, "extensionTokens.$[t].createdAt": ts } },
            { arrayFilters: [{ "t.token": token }] }
          );
        } else if (pgCanonical) {
          await __deps.updateUserExtensionTokenTimestamp(String(user.id ?? user._id), ts);
          await shadowWriteMongoIdentity(
            "users.extensionTokenCreatedAt",
            async () => {
              const m = await __deps.getDb();
              await m.collection("users").updateOne(
                { _id: user._id ?? user.id },
                { $set: { extensionTokenCreatedAt: ts } },
              );
            },
          );
        } else {
          if (!db) db = await __deps.getDb();
          await db.collection("users").updateOne(
            { _id: user._id },
            { $set: { extensionTokenCreatedAt: ts } }
          );
        }
      } catch (err) {
        console.warn("[Extension Auth] Failed to refresh token timestamp:", err);
      }
    }
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

  return { user, authorized: true, error: null };
}

export function getAuthErrorStatus(auth: ExtensionAuthResult): number {
  if (auth.serverError) return 503;
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

export function getUserShopIds(user: any): string[] {
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
