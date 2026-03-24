import { getPostgresClient } from "../postgres";

export type CommConversation = {
  id: string;
  shop_id: number;
  channel: "voice" | "sms" | "email";
  status: "active" | "closed" | "missed" | "voicemail";
  direction: "inbound" | "outbound";
  customer_phone: string;
  customer_name: string | null;
  customer_id: string | null;
  assigned_user_email: string | null;
  subject: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

export type CommMessage = {
  id: string;
  conversation_id: string;
  channel: "voice" | "sms";
  direction: "inbound" | "outbound";
  from_number: string;
  to_number: string;
  body: string | null;
  call_sid: string | null;
  call_status: string | null;
  call_duration: number | null;
  recording_url: string | null;
  media_urls: string[] | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type CommConversationFilters = {
  shop_id: number;
  status?: string;
  channel?: string;
  limit?: number;
  offset?: number;
};

const sql = () => getPostgresClient();

export async function ensureCommConversationsTable() {
  await sql()`
    CREATE TABLE IF NOT EXISTS comm_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id INTEGER NOT NULL,
      channel VARCHAR(20) NOT NULL DEFAULT 'voice',
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      direction VARCHAR(20) NOT NULL DEFAULT 'inbound',
      customer_phone VARCHAR(30) NOT NULL,
      customer_name VARCHAR(255),
      customer_id VARCHAR(255),
      assigned_user_email VARCHAR(255),
      subject VARCHAR(500),
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    )
  `;
  await sql()`
    CREATE INDEX IF NOT EXISTS idx_comm_conversations_shop_id ON comm_conversations(shop_id)
  `;
  await sql()`
    CREATE INDEX IF NOT EXISTS idx_comm_conversations_customer_phone ON comm_conversations(customer_phone)
  `;
  await sql()`
    CREATE INDEX IF NOT EXISTS idx_comm_conversations_status ON comm_conversations(status)
  `;
}

export async function ensureCommMessagesTable() {
  await sql()`
    CREATE TABLE IF NOT EXISTS comm_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES comm_conversations(id) ON DELETE CASCADE,
      channel VARCHAR(20) NOT NULL DEFAULT 'voice',
      direction VARCHAR(20) NOT NULL DEFAULT 'inbound',
      from_number VARCHAR(30) NOT NULL,
      to_number VARCHAR(30) NOT NULL,
      body TEXT,
      call_sid VARCHAR(100),
      call_status VARCHAR(30),
      call_duration INTEGER,
      recording_url TEXT,
      media_urls JSONB,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql()`
    CREATE INDEX IF NOT EXISTS idx_comm_messages_conversation_id ON comm_messages(conversation_id)
  `;
  await sql()`
    CREATE INDEX IF NOT EXISTS idx_comm_messages_call_sid ON comm_messages(call_sid)
  `;
}

export async function listCommConversations(filters: CommConversationFilters): Promise<CommConversation[]> {
  const { shop_id, status, channel, limit = 50, offset = 0 } = filters;

  if (status && channel) {
    const rows = await sql()`
      SELECT * FROM comm_conversations
      WHERE shop_id = ${shop_id} AND status = ${status} AND channel = ${channel}
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows as unknown as CommConversation[];
  }

  if (status) {
    const rows = await sql()`
      SELECT * FROM comm_conversations
      WHERE shop_id = ${shop_id} AND status = ${status}
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows as unknown as CommConversation[];
  }

  if (channel) {
    const rows = await sql()`
      SELECT * FROM comm_conversations
      WHERE shop_id = ${shop_id} AND channel = ${channel}
      ORDER BY updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows as unknown as CommConversation[];
  }

  const rows = await sql()`
    SELECT * FROM comm_conversations
    WHERE shop_id = ${shop_id}
    ORDER BY updated_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows as unknown as CommConversation[];
}

export async function getCommConversation(id: string): Promise<CommConversation | null> {
  const rows = await sql()`
    SELECT * FROM comm_conversations WHERE id = ${id}
  `;
  return (rows[0] as unknown as CommConversation) || null;
}

export async function createCommConversation(data: {
  shop_id: number;
  channel: string;
  direction: string;
  customer_phone: string;
  customer_name?: string | null;
  customer_id?: string | null;
  assigned_user_email?: string | null;
  subject?: string | null;
  status?: string;
  metadata?: Record<string, unknown> | null;
}): Promise<CommConversation> {
  const rows = await sql()`
    INSERT INTO comm_conversations (
      shop_id, channel, direction, customer_phone, customer_name,
      customer_id, assigned_user_email, subject, status, metadata
    ) VALUES (
      ${data.shop_id}, ${data.channel}, ${data.direction}, ${data.customer_phone},
      ${data.customer_name || null}, ${data.customer_id || null},
      ${data.assigned_user_email || null}, ${data.subject || null},
      ${data.status || "active"}, ${data.metadata ? JSON.stringify(data.metadata) : null}
    )
    RETURNING *
  `;
  return rows[0] as unknown as CommConversation;
}

export async function updateCommConversation(
  id: string,
  data: Partial<{
    status: string;
    customer_name: string | null;
    customer_id: string | null;
    assigned_user_email: string | null;
    subject: string | null;
    metadata: Record<string, unknown> | null;
    closed_at: string | null;
  }>
): Promise<CommConversation | null> {
  const rows = await sql()`
    UPDATE comm_conversations SET
      status = COALESCE(${data.status || null}, status),
      customer_name = COALESCE(${data.customer_name !== undefined ? data.customer_name : null}, customer_name),
      customer_id = COALESCE(${data.customer_id !== undefined ? data.customer_id : null}, customer_id),
      assigned_user_email = COALESCE(${data.assigned_user_email !== undefined ? data.assigned_user_email : null}, assigned_user_email),
      subject = COALESCE(${data.subject !== undefined ? data.subject : null}, subject),
      metadata = COALESCE(${data.metadata ? JSON.stringify(data.metadata) : null}, metadata),
      closed_at = COALESCE(${data.closed_at || null}, closed_at),
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return (rows[0] as unknown as CommConversation) || null;
}

export async function findCommConversationByPhone(
  shop_id: number,
  customer_phone: string,
  channel: string
): Promise<CommConversation | null> {
  const rows = await sql()`
    SELECT * FROM comm_conversations
    WHERE shop_id = ${shop_id}
      AND customer_phone = ${customer_phone}
      AND channel = ${channel}
      AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  return (rows[0] as unknown as CommConversation) || null;
}

export async function addCommMessage(data: {
  conversation_id: string;
  channel: string;
  direction: string;
  from_number: string;
  to_number: string;
  body?: string | null;
  call_sid?: string | null;
  call_status?: string | null;
  call_duration?: number | null;
  recording_url?: string | null;
  media_urls?: string[] | null;
  metadata?: Record<string, unknown> | null;
}): Promise<CommMessage> {
  const rows = await sql()`
    INSERT INTO comm_messages (
      conversation_id, channel, direction, from_number, to_number,
      body, call_sid, call_status, call_duration, recording_url,
      media_urls, metadata
    ) VALUES (
      ${data.conversation_id}, ${data.channel}, ${data.direction},
      ${data.from_number}, ${data.to_number},
      ${data.body || null}, ${data.call_sid || null},
      ${data.call_status || null}, ${data.call_duration || null},
      ${data.recording_url || null},
      ${data.media_urls ? JSON.stringify(data.media_urls) : null},
      ${data.metadata ? JSON.stringify(data.metadata) : null}
    )
    RETURNING *
  `;

  await sql()`
    UPDATE comm_conversations SET updated_at = NOW() WHERE id = ${data.conversation_id}
  `;

  return rows[0] as unknown as CommMessage;
}

export async function getCommMessages(
  conversation_id: string,
  limit = 100,
  offset = 0
): Promise<CommMessage[]> {
  const rows = await sql()`
    SELECT * FROM comm_messages
    WHERE conversation_id = ${conversation_id}
    ORDER BY created_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows as unknown as CommMessage[];
}

export async function updateCommMessageByCallSid(
  callSid: string,
  data: Partial<{
    call_status: string;
    call_duration: number;
    recording_url: string;
  }>
): Promise<CommMessage | null> {
  const rows = await sql()`
    UPDATE comm_messages SET
      call_status = COALESCE(${data.call_status || null}, call_status),
      call_duration = COALESCE(${data.call_duration !== undefined ? data.call_duration : null}, call_duration),
      recording_url = COALESCE(${data.recording_url || null}, recording_url)
    WHERE call_sid = ${callSid}
    RETURNING *
  `;
  return (rows[0] as unknown as CommMessage) || null;
}

export async function getCallActivity(
  shop_id: number,
  startDate?: string,
  endDate?: string
): Promise<{ total: number; inbound: number; outbound: number; missed: number; avgDuration: number }> {
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const end = endDate || new Date().toISOString();

  const rows = await sql()`
    SELECT
      COUNT(*)::int as total,
      COUNT(*) FILTER (WHERE c.direction = 'inbound')::int as inbound,
      COUNT(*) FILTER (WHERE c.direction = 'outbound')::int as outbound,
      COUNT(*) FILTER (WHERE c.status = 'missed')::int as missed,
      COALESCE(AVG(m.call_duration) FILTER (WHERE m.call_duration > 0), 0)::int as avg_duration
    FROM comm_conversations c
    LEFT JOIN comm_messages m ON m.conversation_id = c.id
    WHERE c.shop_id = ${shop_id}
      AND c.channel = 'voice'
      AND c.created_at >= ${start}
      AND c.created_at <= ${end}
  `;

  const row = rows[0] as any;
  return {
    total: row.total || 0,
    inbound: row.inbound || 0,
    outbound: row.outbound || 0,
    missed: row.missed || 0,
    avgDuration: row.avg_duration || 0,
  };
}
