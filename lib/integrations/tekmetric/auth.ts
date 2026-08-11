import {
  getCurrentToken,
  upsertCurrentToken,
  deleteCurrentToken,
} from "@/lib/data/repositories/tekmetric-ops";

const TEKMETRIC_BASE_URL = 'https://shop.tekmetric.com';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
// Bound the OAuth token fetch the same way client requests are bounded — a
// hung token request would otherwise stall every caller waiting on a token.
const TOKEN_FETCH_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.TEKMETRIC_REQUEST_TIMEOUT_MS) || 60000,
);

interface TekmetricToken {
  accessToken: string;
  tokenType: string;
  scope: string;
  expiresAt: Date;
  createdAt: Date;
}

interface TokenDocument {
  tokenKey: string;
  accessToken: string;
  tokenType: string;
  scope: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Credential lane. Task #1079: one Tekmetric API key (10 RPS) shared
 * between advisor-facing requests and all background sync meant every
 * backfill/cron burst competed with users for the same per-key budget.
 * When a second key dedicated to background work is provisioned
 * (`TEKMETRIC_BG_CLIENT_ID` / `TEKMETRIC_BG_CLIENT_SECRET`), background-
 * priority traffic authenticates on its own credential and is paced
 * against its own rate buckets — the two lanes then never contend.
 * With the BG envs unset, everything falls back to the primary key and
 * behavior is exactly as before.
 */
export type TekmetricAuthLane = 'primary' | 'background';

const cachedTokens: Record<TekmetricAuthLane, TekmetricToken | null> = {
  primary: null,
  background: null,
};

export function hasBackgroundCredentials(): boolean {
  return Boolean(process.env.TEKMETRIC_BG_CLIENT_ID && process.env.TEKMETRIC_BG_CLIENT_SECRET);
}

function getClientCredentials(lane: TekmetricAuthLane = 'primary'): { clientId: string; clientSecret: string } {
  if (lane === 'background') {
    const clientId = process.env.TEKMETRIC_BG_CLIENT_ID;
    const clientSecret = process.env.TEKMETRIC_BG_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('TEKMETRIC_BG_CLIENT_ID and TEKMETRIC_BG_CLIENT_SECRET must be configured for the background lane');
    }
    return { clientId, clientSecret };
  }

  const clientId = process.env.TEKMETRIC_CLIENT_ID;
  const clientSecret = process.env.TEKMETRIC_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    throw new Error('TEKMETRIC_CLIENT_ID and TEKMETRIC_CLIENT_SECRET must be configured');
  }
  
  return { clientId, clientSecret };
}

async function fetchNewToken(lane: TekmetricAuthLane = 'primary'): Promise<TekmetricToken> {
  const { clientId, clientSecret } = getClientCredentials(lane);
  
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  
  console.log(`[Tekmetric Auth] Fetching new access token (${lane} lane)...`);
  
  const response = await fetch(`${TEKMETRIC_BASE_URL}/api/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[Tekmetric Auth] Token fetch failed:', response.status, errorText);
    throw new Error(`Failed to fetch Tekmetric token: ${response.status} ${errorText}`);
  }
  
  const data = await response.json();
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000);
  
  const token: TekmetricToken = {
    accessToken: data.access_token,
    tokenType: data.token_type || 'bearer',
    scope: data.scope || '',
    expiresAt,
    createdAt: new Date(),
  };
  
  console.log(`[Tekmetric Auth] New token obtained (${lane} lane), expires at ${expiresAt.toISOString()}`);
  
  return token;
}

async function persistToken(token: TekmetricToken): Promise<void> {
  try {
    await upsertCurrentToken({
      accessToken: token.accessToken,
      tokenType: token.tokenType,
      scope: token.scope,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    });
  } catch (err) {
    console.error('[Tekmetric Auth] Failed to persist token:', err);
  }
}

async function loadPersistedToken(): Promise<TekmetricToken | null> {
  try {
    const doc = (await getCurrentToken()) as TokenDocument | null;

    if (!doc) return null;

    return {
      accessToken: doc.accessToken,
      tokenType: doc.tokenType,
      scope: doc.scope,
      expiresAt: new Date(doc.expiresAt),
      createdAt: new Date(doc.createdAt),
    };
  } catch (err) {
    console.error('[Tekmetric Auth] Failed to load persisted token:', err);
    return null;
  }
}

function isTokenExpired(token: TekmetricToken): boolean {
  return new Date() >= new Date(token.expiresAt.getTime() - TOKEN_REFRESH_BUFFER_MS);
}

export async function getValidToken(lane: TekmetricAuthLane = 'primary'): Promise<string> {
  const cached = cachedTokens[lane];
  if (cached && !isTokenExpired(cached)) {
    return cached.accessToken;
  }

  // Only the primary lane's token is persisted (the central `{tokenKey:
  // "current"}` doc / PG shop_id=0 sentinel row predates lanes). The
  // background lane keeps its token in-process only: one extra OAuth call
  // per process per ~55 minutes is negligible, and it avoids widening the
  // single-token storage contract.
  if (lane === 'primary') {
    const persistedToken = await loadPersistedToken();
    if (persistedToken && !isTokenExpired(persistedToken)) {
      cachedTokens.primary = persistedToken;
      return persistedToken.accessToken;
    }
  }

  const newToken = await fetchNewToken(lane);
  cachedTokens[lane] = newToken;
  if (lane === 'primary') {
    await persistToken(newToken);
  }
  
  return newToken.accessToken;
}

export async function refreshToken(lane: TekmetricAuthLane = 'primary'): Promise<string> {
  console.log(`[Tekmetric Auth] Force refreshing token (${lane} lane)...`);
  
  const newToken = await fetchNewToken(lane);
  cachedTokens[lane] = newToken;
  if (lane === 'primary') {
    await persistToken(newToken);
  }
  
  return newToken.accessToken;
}

export async function invalidateToken(): Promise<void> {
  cachedTokens.primary = null;
  cachedTokens.background = null;
  
  try {
    await deleteCurrentToken();
  } catch (err) {
    console.error('[Tekmetric Auth] Failed to invalidate token:', err);
  }
}

export function clearCachedToken(lane: TekmetricAuthLane = 'primary'): void {
  cachedTokens[lane] = null;
}

export function isConfigured(): boolean {
  return Boolean(process.env.TEKMETRIC_CLIENT_ID && process.env.TEKMETRIC_CLIENT_SECRET);
}
