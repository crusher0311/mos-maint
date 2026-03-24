import { eq, desc, and, sql } from "drizzle-orm";
import { getDb } from "../drizzle";
import {
  conversations,
  conversationMessages,
  conversationParticipants,
} from "../schema";

type NewConversation = typeof conversations.$inferInsert;
type NewMessage = typeof conversationMessages.$inferInsert;
type NewParticipant = typeof conversationParticipants.$inferInsert;

export async function createConversation(data: NewConversation) {
  const db = getDb();
  const [result] = await db.insert(conversations).values(data).returning();
  return result;
}

export async function getConversationById(id: number) {
  const db = getDb();
  return db.query.conversations.findFirst({
    where: eq(conversations.id, id),
    with: {
      messages: {
        orderBy: [desc(conversationMessages.createdAt)],
        limit: 50,
      },
      participants: true,
    },
  });
}

export async function getConversationsByShopId(
  shopId: number,
  options: { limit?: number; offset?: number; status?: "active" | "archived" | "closed" } = {},
) {
  const db = getDb();
  const { limit = 50, offset = 0, status } = options;

  const conditions = [eq(conversations.shopId, shopId)];
  if (status) {
    conditions.push(eq(conversations.status, status));
  }

  return db.query.conversations.findMany({
    where: and(...conditions),
    orderBy: [desc(conversations.lastMessageAt)],
    limit,
    offset,
  });
}

export async function updateConversation(
  id: number,
  data: Partial<NewConversation>,
) {
  const db = getDb();
  const [result] = await db
    .update(conversations)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(conversations.id, id))
    .returning();
  return result;
}

export async function addMessage(data: NewMessage) {
  const db = getDb();

  return db.transaction(async (tx) => {
    const [message] = await tx
      .insert(conversationMessages)
      .values(data)
      .returning();

    const isInbound = data.direction === "inbound";
    await tx
      .update(conversations)
      .set({
        lastMessageAt: new Date(),
        lastMessagePreview: data.body?.substring(0, 200) ?? null,
        updatedAt: new Date(),
        ...(isInbound
          ? { unreadCount: sql`${conversations.unreadCount} + 1` }
          : {}),
      })
      .where(eq(conversations.id, data.conversationId));

    return message;
  });
}

export async function getMessages(
  conversationId: number,
  options: { limit?: number; offset?: number } = {},
) {
  const db = getDb();
  const { limit = 50, offset = 0 } = options;

  return db.query.conversationMessages.findMany({
    where: eq(conversationMessages.conversationId, conversationId),
    orderBy: [desc(conversationMessages.createdAt)],
    limit,
    offset,
  });
}

export async function addParticipant(data: NewParticipant) {
  const db = getDb();
  const [result] = await db
    .insert(conversationParticipants)
    .values(data)
    .returning();
  return result;
}

export async function markConversationRead(id: number) {
  const db = getDb();
  const [result] = await db
    .update(conversations)
    .set({ unreadCount: 0, updatedAt: new Date() })
    .where(eq(conversations.id, id))
    .returning();
  return result;
}
