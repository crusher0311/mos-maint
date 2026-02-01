import sql from "@/lib/db/postgres";

export interface ConversationEntry {
  sessionId: string;
  role: "user" | "agent" | "system";
  messageType?: string;
  content: string;
  metadata?: Record<string, unknown>;
  checkpointId?: string;
  filesAffected?: string[];
}

export async function logConversation(entry: ConversationEntry): Promise<void> {
  await sql`
    INSERT INTO conversation_log (session_id, role, message_type, content, metadata, checkpoint_id, files_affected)
    VALUES (
      ${entry.sessionId},
      ${entry.role},
      ${entry.messageType || null},
      ${entry.content},
      ${JSON.stringify(entry.metadata || {})}::jsonb,
      ${entry.checkpointId || null},
      ${entry.filesAffected || null}
    )
  `;
}

export async function logCheckpoint(
  sessionId: string,
  checkpointId: string,
  summary: string,
  filesAffected: string[]
): Promise<void> {
  await logConversation({
    sessionId,
    role: "system",
    messageType: "checkpoint",
    content: summary,
    checkpointId,
    filesAffected,
  });
}

export async function logUserRequest(sessionId: string, content: string): Promise<void> {
  await logConversation({
    sessionId,
    role: "user",
    messageType: "request",
    content,
  });
}

export async function logAgentAction(
  sessionId: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await logConversation({
    sessionId,
    role: "agent",
    messageType: "action",
    content,
    metadata,
  });
}

export async function getSessionHistory(sessionId: string): Promise<ConversationEntry[]> {
  const rows = await sql`
    SELECT session_id, role, message_type, content, metadata, checkpoint_id, files_affected, timestamp
    FROM conversation_log
    WHERE session_id = ${sessionId}
    ORDER BY timestamp ASC
  `;
  
  return rows.map(row => ({
    sessionId: row.session_id as string,
    role: row.role as "user" | "agent" | "system",
    messageType: row.message_type as string,
    content: row.content as string,
    metadata: row.metadata as Record<string, unknown>,
    checkpointId: row.checkpoint_id as string,
    filesAffected: row.files_affected as string[],
  }));
}

export async function getRecentSessions(limit = 10): Promise<{ sessionId: string; firstEntry: Date; lastEntry: Date; entryCount: number }[]> {
  const rows = await sql`
    SELECT 
      session_id,
      MIN(timestamp) as first_entry,
      MAX(timestamp) as last_entry,
      COUNT(*) as entry_count
    FROM conversation_log
    GROUP BY session_id
    ORDER BY MAX(timestamp) DESC
    LIMIT ${limit}
  `;
  
  return rows.map(row => ({
    sessionId: row.session_id as string,
    firstEntry: new Date(row.first_entry as string),
    lastEntry: new Date(row.last_entry as string),
    entryCount: Number(row.entry_count),
  }));
}
