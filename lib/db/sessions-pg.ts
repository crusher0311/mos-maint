import sql from "@/lib/db/postgres";

export interface Session {
  id: string;
  token: string;
  user_id: string;
  expires_at: Date;
  created_at: Date;
  shop_id: string | null;
  is_impersonation: boolean;
  impersonated_by: string | null;
}

export async function getSessionByToken(token: string): Promise<Session | null> {
  const sessions = await sql<Session[]>`
    SELECT * FROM sessions 
    WHERE token = ${token} AND expires_at > NOW()
    LIMIT 1
  `;
  return sessions[0] || null;
}

export async function getSessionById(sessionId: string): Promise<Session | null> {
  const sessions = await sql<Session[]>`
    SELECT * FROM sessions WHERE id = ${sessionId} LIMIT 1
  `;
  return sessions[0] || null;
}

export async function createSession(data: {
  token: string;
  userId: string;
  expiresAt: Date;
  shopId?: string | null;
  isImpersonation?: boolean;
  impersonatedBy?: string | null;
}): Promise<Session> {
  const now = new Date();
  
  const sessions = await sql<Session[]>`
    INSERT INTO sessions (
      id, token, user_id, expires_at, created_at,
      shop_id, is_impersonation, impersonated_by
    ) VALUES (
      gen_random_uuid(),
      ${data.token},
      ${data.userId},
      ${data.expiresAt},
      ${now},
      ${data.shopId || null},
      ${data.isImpersonation || false},
      ${data.impersonatedBy || null}
    )
    RETURNING *
  `;
  
  return sessions[0];
}

export async function deleteSession(token: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE token = ${token}`;
}

export async function deleteSessionsByUserId(userId: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
}

export async function deleteExpiredSessions(): Promise<number> {
  const result = await sql`DELETE FROM sessions WHERE expires_at < NOW()`;
  return result.count || 0;
}

export async function extendSession(token: string, newExpiresAt: Date): Promise<void> {
  await sql`
    UPDATE sessions SET expires_at = ${newExpiresAt} WHERE token = ${token}
  `;
}
