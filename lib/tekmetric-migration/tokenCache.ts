/**
 * Two-token cache accessor for the Detect Dog migration wizard.
 *
 * Tekmetric mints a *single-shop-scoped* `x-auth-token` per browser tab — so
 * the wizard always needs TWO independently-captured tokens (one for the
 * source shop, one for the dest shop). The MOS extension already relays
 * the per-shop token into Mongo via `/api/extension/auth-token` (debounced
 * every 30 minutes by `mos-tools-extension/background.js`), writing the
 * value into `shops.tekmetric.xAuthToken` along with `xAuthTokenUpdatedAt`.
 *
 * This module is a thin server-side accessor on top of that cache:
 *   - `getTokenForSmsShopId` → returns the cached token + freshness for
 *     a given Tekmetric numeric shop id (no MOS-shop-id mapping needed).
 *   - `getTokenStatus` → boolean/age helper for the wizard's UI badges.
 *   - `requireTokensForRun` → fetches both source & dest tokens together
 *     and returns a friendly error if either is stale/missing.
 *
 * Freshness threshold: 60 minutes — Tekmetric tokens last ~24h in practice
 * but the extension refreshes them every 30 min, so anything older than
 * 60 min usually means the shop hasn't been opened recently.
 */
import { getDb } from "@/lib/mongo";

export const TOKEN_FRESH_MS = 60 * 60 * 1000;

export interface TokenStatus {
  smsShopId: number;
  hasToken: boolean;
  ageMs: number | null;
  fresh: boolean;
  updatedAt: Date | null;
  source: string | null;
}

interface TokenLookup {
  token: string;
  status: TokenStatus;
}

/**
 * Looks up the cached Tekmetric x-auth-token for a numeric Tekmetric shop id.
 * Returns null if no shop matches or no token has ever been cached.
 */
export async function getTokenForSmsShopId(
  smsShopId: number,
): Promise<TokenLookup | null> {
  const db = await getDb();
  const tekShopIdNum = Number(smsShopId);
  const tekShopIdStr = String(smsShopId);
  const shopDoc = await db.collection("shops").findOne(
    {
      $or: [
        { "tekmetric.shopId": tekShopIdNum },
        { "tekmetric.shopId": tekShopIdStr },
        { tekmetricShopId: tekShopIdNum },
        { tekmetricShopId: tekShopIdStr },
      ],
    },
    {
      projection: {
        "tekmetric.xAuthToken": 1,
        "tekmetric.xAuthTokenUpdatedAt": 1,
        "tekmetric.xAuthTokenSource": 1,
        "tekmetric.shopId": 1,
        shopId: 1,
        name: 1,
      },
    },
  );
  if (!shopDoc) return null;
  const tek = (shopDoc as any).tekmetric || {};
  const token: string | null = tek.xAuthToken || null;
  const updatedAt: Date | null = tek.xAuthTokenUpdatedAt
    ? new Date(tek.xAuthTokenUpdatedAt)
    : null;
  const ageMs = updatedAt ? Date.now() - updatedAt.getTime() : null;
  const fresh = !!token && ageMs !== null && ageMs <= TOKEN_FRESH_MS;
  if (!token) return null;
  return {
    token,
    status: {
      smsShopId: tekShopIdNum,
      hasToken: true,
      ageMs,
      fresh,
      updatedAt,
      source: tek.xAuthTokenSource || null,
    },
  };
}

export async function getTokenStatus(smsShopId: number): Promise<TokenStatus> {
  const lookup = await getTokenForSmsShopId(smsShopId);
  if (!lookup) {
    return {
      smsShopId,
      hasToken: false,
      ageMs: null,
      fresh: false,
      updatedAt: null,
      source: null,
    };
  }
  return lookup.status;
}

export interface TwoTokenBundle {
  source: { smsShopId: number; token: string; status: TokenStatus };
  dest: { smsShopId: number; token: string; status: TokenStatus };
}

export async function requireTokensForRun(args: {
  sourceSmsShopId: number;
  destSmsShopId: number;
  /** when true, throws if either token is older than the freshness window */
  requireFresh?: boolean;
}): Promise<TwoTokenBundle> {
  const [src, dst] = await Promise.all([
    getTokenForSmsShopId(args.sourceSmsShopId),
    getTokenForSmsShopId(args.destSmsShopId),
  ]);
  if (!src) {
    throw new Error(
      `No cached Tekmetric token for source shop ${args.sourceSmsShopId}. Open that shop in your browser with the MOS extension installed, then retry.`,
    );
  }
  if (!dst) {
    throw new Error(
      `No cached Tekmetric token for dest shop ${args.destSmsShopId}. Open that shop in your browser with the MOS extension installed, then retry.`,
    );
  }
  if (args.requireFresh) {
    if (!src.status.fresh) {
      throw new Error(
        `Source-shop token is stale (age ${Math.round((src.status.ageMs ?? 0) / 60000)}min). Re-open shop ${args.sourceSmsShopId} in the browser to refresh.`,
      );
    }
    if (!dst.status.fresh) {
      throw new Error(
        `Dest-shop token is stale (age ${Math.round((dst.status.ageMs ?? 0) / 60000)}min). Re-open shop ${args.destSmsShopId} in the browser to refresh.`,
      );
    }
  }
  return {
    source: {
      smsShopId: args.sourceSmsShopId,
      token: src.token,
      status: src.status,
    },
    dest: {
      smsShopId: args.destSmsShopId,
      token: dst.token,
      status: dst.status,
    },
  };
}
