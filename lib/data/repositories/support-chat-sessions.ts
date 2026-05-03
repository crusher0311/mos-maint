// Repository for the `support_chat_sessions` collection.
import type { Collection, ObjectId as ObjectIdType } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "support_chat_sessions";

export interface ChatMessageDoc {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  articleIds?: string[];
}

export interface ChatSessionDoc {
  _id?: ObjectIdType;
  sessionId: string;
  userEmail: string;
  shopId: number;
  messages: ChatMessageDoc[];
  createdAt: Date;
  updatedAt: Date;
  resolved: boolean;
  escalatedToTicket?: string;
}

async function collection(): Promise<Collection<ChatSessionDoc>> {
  const db = await getDb();
  return db.collection<ChatSessionDoc>(COLLECTION);
}

export async function findActiveSessionForUser(
  userEmail: string,
  shopId: number,
  windowMs: number,
): Promise<ChatSessionDoc | null> {
  const col = await collection();
  return col.findOne({
    userEmail,
    shopId,
    resolved: false,
    updatedAt: { $gte: new Date(Date.now() - windowMs) },
  });
}

export async function insertSession(
  doc: Omit<ChatSessionDoc, "_id">,
): Promise<ObjectIdType> {
  const col = await collection();
  const res = await col.insertOne(doc);
  return res.insertedId;
}

export async function findSessionBySessionId(
  sessionId: string,
): Promise<ChatSessionDoc | null> {
  const col = await collection();
  return col.findOne({ sessionId });
}

export async function pushMessage(
  sessionId: string,
  message: ChatMessageDoc,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { sessionId },
    { $push: { messages: message }, $set: { updatedAt: new Date() } },
  );
}

export async function setResolved(sessionId: string): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { sessionId },
    { $set: { resolved: true, updatedAt: new Date() } },
  );
}

export async function setEscalatedTicket(
  sessionId: string,
  ticketId: string,
): Promise<void> {
  const col = await collection();
  await col.updateOne(
    { sessionId },
    { $set: { escalatedToTicket: ticketId, updatedAt: new Date() } },
  );
}

export async function listForUser(
  userEmail: string,
  limit: number,
): Promise<ChatSessionDoc[]> {
  const col = await collection();
  return col
    .find({ userEmail })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();
}
