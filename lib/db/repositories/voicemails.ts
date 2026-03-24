import { eq, desc, and } from "drizzle-orm";
import { getDb } from "../drizzle";
import { voicemails } from "../schema";

type NewVoicemail = typeof voicemails.$inferInsert;

export async function createVoicemail(data: NewVoicemail) {
  const db = getDb();
  const [result] = await db.insert(voicemails).values(data).returning();
  return result;
}

export async function getVoicemailsByShopId(
  shopId: number,
  options: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
) {
  const db = getDb();
  const { limit = 50, offset = 0, unreadOnly = false } = options;

  const conditions = [
    eq(voicemails.shopId, shopId),
    eq(voicemails.isArchived, false),
  ];
  if (unreadOnly) {
    conditions.push(eq(voicemails.isRead, false));
  }

  return db.query.voicemails.findMany({
    where: and(...conditions),
    orderBy: [desc(voicemails.createdAt)],
    limit,
    offset,
  });
}

export async function getVoicemailById(id: number) {
  const db = getDb();
  return db.query.voicemails.findFirst({
    where: eq(voicemails.id, id),
  });
}

export async function markVoicemailRead(id: number) {
  const db = getDb();
  const [result] = await db
    .update(voicemails)
    .set({ isRead: true })
    .where(eq(voicemails.id, id))
    .returning();
  return result;
}

export async function archiveVoicemail(id: number) {
  const db = getDb();
  const [result] = await db
    .update(voicemails)
    .set({ isArchived: true })
    .where(eq(voicemails.id, id))
    .returning();
  return result;
}
