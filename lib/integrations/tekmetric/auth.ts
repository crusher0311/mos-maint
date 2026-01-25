import { getDb } from "@/lib/mongo";

const TEKMETRIC_BASE_URL = 'https://shop.tekmetric.com';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

let cachedToken: TekmetricToken | null = null;

function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.TEKMETRIC_CLIENT_ID;
  const clientSecret = process.env.TEKMETRIC_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    throw new Error('TEKMETRIC_CLIENT_ID and TEKMETRIC_CLIENT_SECRET must be configured');
  }
  
  return { clientId, clientSecret };
}

async function fetchNewToken(): Promise<TekmetricToken> {
  const { clientId, clientSecret } = getClientCredentials();
  
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  
  console.log('[Tekmetric Auth] Fetching new access token...');
  
  const response = await fetch(`${TEKMETRIC_BASE_URL}/api/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
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
  
  console.log(`[Tekmetric Auth] New token obtained, expires at ${expiresAt.toISOString()}`);
  
  return token;
}

async function persistToken(token: TekmetricToken): Promise<void> {
  try {
    const db = await getDb();
    await db.collection("tekmetric_tokens").updateOne(
      { tokenKey: "current" },
      {
        $set: {
          tokenKey: "current",
          accessToken: token.accessToken,
          tokenType: token.tokenType,
          scope: token.scope,
          expiresAt: token.expiresAt,
          createdAt: token.createdAt,
          updatedAt: new Date(),
        }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('[Tekmetric Auth] Failed to persist token:', err);
  }
}

async function loadPersistedToken(): Promise<TekmetricToken | null> {
  try {
    const db = await getDb();
    const doc = await db.collection("tekmetric_tokens").findOne({ tokenKey: "current" }) as TokenDocument | null;
    
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

export async function getValidToken(): Promise<string> {
  if (cachedToken && !isTokenExpired(cachedToken)) {
    return cachedToken.accessToken;
  }
  
  const persistedToken = await loadPersistedToken();
  if (persistedToken && !isTokenExpired(persistedToken)) {
    cachedToken = persistedToken;
    return cachedToken.accessToken;
  }
  
  const newToken = await fetchNewToken();
  cachedToken = newToken;
  await persistToken(newToken);
  
  return newToken.accessToken;
}

export async function refreshToken(): Promise<string> {
  console.log('[Tekmetric Auth] Force refreshing token...');
  
  const newToken = await fetchNewToken();
  cachedToken = newToken;
  await persistToken(newToken);
  
  return newToken.accessToken;
}

export async function invalidateToken(): Promise<void> {
  cachedToken = null;
  
  try {
    const db = await getDb();
    await db.collection("tekmetric_tokens").deleteOne({ tokenKey: "current" });
  } catch (err) {
    console.error('[Tekmetric Auth] Failed to invalidate token:', err);
  }
}

export function clearCachedToken(): void {
  cachedToken = null;
}

export function isConfigured(): boolean {
  return Boolean(process.env.TEKMETRIC_CLIENT_ID && process.env.TEKMETRIC_CLIENT_SECRET);
}
