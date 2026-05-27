import { NextRequest } from "next/server";
import { getDb } from "@/lib/mongo";
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
  try {
    if (pgCanonical) {
      user = await __deps.findUserByExtensionToken(token);
      // Task #502 safety net: while the PG identity cutover is still
      // settling, a row that exists in Mongo `users.extensionToken` but
      // hasn't propagated into PG yet would otherwise log the user out
      // mid-shift. Fall back to a Mongo read on PG-miss and log it so
      // we can quantify the drift. This is intentionally additive — the
      // cutover stays in place; this is just a "don't bounce real
      // customers" net.
      if (!user) {
        try {
          db = await __deps.getDb();
          const mongoUser = await db
            .collection("users")
            .findOne({ extensionToken: token });
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
      user = await db.collection("users").findOne({ extensionToken: token });
    }
  } catch (err) {
    console.error("[Extension Auth] Token lookup failed:", err);
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
    return { user: null, authorized: false, error: "Invalid token", code: "TOKEN_INVALID" };
  }

  if (user.extensionTokenCreatedAt) {
    const tokenAge = Date.now() - new Date(user.extensionTokenCreatedAt).getTime();
    
    if (tokenAge > MAX_TOKEN_AGE_MS) {
      const maskedEmail = user.email ? user.email.replace(/(.{2}).*(@.*)/, '$1***$2') : 'unknown';
      console.log(`[Extension Auth] Token expired: user=${maskedEmail}, age=${Math.round(tokenAge / 86400000)}d, max=${MAX_TOKEN_AGE_MS / 86400000}d, path=${request.nextUrl.pathname}`);
      return { user: null, authorized: false, error: "Token expired", code: "TOKEN_EXPIRED" };
    }

    if (tokenAge > TOKEN_REFRESH_THRESHOLD_MS) {
      const ts = new Date();
      try {
        if (pgCanonical) {
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

  if (requiredShopId) {
    const userShopId = user.shopId?.toString();
    const userShopIds = (user.shopIds || []).map((id: any) => id.toString());
    
    const hasAccess = userShopId === requiredShopId || userShopIds.includes(requiredShopId);
    
    const isPlatformAdmin = user.role === "platform_admin";
    
    if (!hasAccess && !isPlatformAdmin) {
      console.warn(`[Extension Auth] Unauthorized shop access: user ${user.email} (shop ${userShopId}) tried shop ${requiredShopId}`);
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
  
  return shopIds;
}
