import sql from "@/lib/db/postgres";

const TEKMETRIC_BASE_URL = 'https://shop.tekmetric.com';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface TekmetricToken {
  accessToken: string;
  tokenType: string;
  scope: string;
  expiresAt: Date;
  createdAt: Date;
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
  
  console.log(`[Tekmetric Auth] New token obtained, expires at ${expiresAt.toISOString()}, scope: ${token.scope}`);
  
  return token;
}

async function persistToken(token: TekmetricToken): Promise<void> {
  try {
    const scopes = token.scope ? token.scope.split(' ') : [];
    
    await sql`
      INSERT INTO tekmetric_tokens (shop_id, external_shop_id, access_token, refresh_token, token_type, expires_at, scopes, updated_at)
      VALUES (
        NULL,
        0,
        ${token.accessToken},
        '',
        ${token.tokenType},
        ${token.expiresAt},
        ${scopes},
        NOW()
      )
      ON CONFLICT (external_shop_id) WHERE external_shop_id = 0
      DO UPDATE SET
        access_token = EXCLUDED.access_token,
        token_type = EXCLUDED.token_type,
        expires_at = EXCLUDED.expires_at,
        scopes = EXCLUDED.scopes,
        updated_at = NOW()
    `;
  } catch (err) {
    console.error('[Tekmetric Auth] Failed to persist token:', err);
  }
}

async function loadPersistedToken(): Promise<TekmetricToken | null> {
  try {
    const rows = await sql`
      SELECT access_token, token_type, scopes, expires_at, created_at
      FROM tekmetric_tokens
      WHERE external_shop_id = 0
      LIMIT 1
    `;
    
    const doc = rows[0];
    if (!doc) return null;
    
    const scopes = doc.scopes as string[] | null;
    
    return {
      accessToken: doc.access_token as string,
      tokenType: doc.token_type as string,
      scope: scopes ? scopes.join(' ') : '',
      expiresAt: new Date(doc.expires_at as string),
      createdAt: new Date(doc.created_at as string),
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
    await sql`DELETE FROM tekmetric_tokens WHERE external_shop_id = 0`;
  } catch (err) {
    console.error('[Tekmetric Auth] Failed to invalidate token:', err);
  }
}

export function clearCachedToken(): void {
  cachedToken = null;
}
