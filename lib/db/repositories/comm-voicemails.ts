import { getPostgresClient } from "../postgres";

export type CommVoicemail = {
  id: string;
  shop_id: number;
  conversation_id: string | null;
  caller_phone: string;
  caller_name: string | null;
  customer_id: string | null;
  recording_url: string;
  recording_sid: string;
  duration: number;
  status: "new" | "listened" | "archived";
  transcription: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

const sql = () => getPostgresClient();

export async function ensureCommVoicemailsTable() {
  await sql()`
    CREATE TABLE IF NOT EXISTS comm_voicemails (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id INTEGER NOT NULL,
      conversation_id UUID REFERENCES comm_conversations(id) ON DELETE SET NULL,
      caller_phone VARCHAR(30) NOT NULL,
      caller_name VARCHAR(255),
      customer_id VARCHAR(255),
      recording_url TEXT NOT NULL,
      recording_sid VARCHAR(100) NOT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'new',
      transcription TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql()`
    CREATE INDEX IF NOT EXISTS idx_comm_voicemails_shop_id ON comm_voicemails(shop_id)
  `;
  await sql()`
    CREATE INDEX IF NOT EXISTS idx_comm_voicemails_status ON comm_voicemails(status)
  `;
}

export async function listCommVoicemails(
  shop_id: number,
  filters?: { status?: string; limit?: number; offset?: number }
): Promise<CommVoicemail[]> {
  const { status, limit = 50, offset = 0 } = filters || {};

  if (status) {
    const rows = await sql()`
      SELECT * FROM comm_voicemails
      WHERE shop_id = ${shop_id} AND status = ${status}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows as unknown as CommVoicemail[];
  }

  const rows = await sql()`
    SELECT * FROM comm_voicemails
    WHERE shop_id = ${shop_id}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows as unknown as CommVoicemail[];
}

export async function getCommVoicemail(id: string): Promise<CommVoicemail | null> {
  const rows = await sql()`
    SELECT * FROM comm_voicemails WHERE id = ${id}
  `;
  return (rows[0] as unknown as CommVoicemail) || null;
}

export async function createCommVoicemail(data: {
  shop_id: number;
  conversation_id?: string | null;
  caller_phone: string;
  caller_name?: string | null;
  customer_id?: string | null;
  recording_url: string;
  recording_sid: string;
  duration: number;
  transcription?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<CommVoicemail> {
  const rows = await sql()`
    INSERT INTO comm_voicemails (
      shop_id, conversation_id, caller_phone, caller_name,
      customer_id, recording_url, recording_sid, duration,
      transcription, metadata
    ) VALUES (
      ${data.shop_id}, ${data.conversation_id || null}, ${data.caller_phone},
      ${data.caller_name || null}, ${data.customer_id || null},
      ${data.recording_url}, ${data.recording_sid}, ${data.duration},
      ${data.transcription || null},
      ${data.metadata ? JSON.stringify(data.metadata) : null}
    )
    RETURNING *
  `;
  return rows[0] as unknown as CommVoicemail;
}

export async function updateCommVoicemailStatus(
  id: string,
  status: "new" | "listened" | "archived"
): Promise<CommVoicemail | null> {
  const rows = await sql()`
    UPDATE comm_voicemails SET
      status = ${status},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return (rows[0] as unknown as CommVoicemail) || null;
}
