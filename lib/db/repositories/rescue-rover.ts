import { eq, desc, and } from "drizzle-orm";
import { getDb } from "../drizzle";
import {
  rescueRoverSettings,
  rescueRoverCallLogs,
  rescueRoverSafetyRules,
  rescueRoverPromptTemplates,
  rescueRoverVoiceScripts,
  rescueRoverContextRules,
  rescueRoverRcsLinks,
} from "../schema";

type NewSettings = typeof rescueRoverSettings.$inferInsert;
type NewCallLog = typeof rescueRoverCallLogs.$inferInsert;

export async function getRescueRoverSettings(shopId: number) {
  const db = getDb();
  return db.query.rescueRoverSettings.findFirst({
    where: eq(rescueRoverSettings.shopId, shopId),
  });
}

export async function upsertRescueRoverSettings(data: NewSettings) {
  const db = getDb();
  const existing = await getRescueRoverSettings(data.shopId);

  if (existing) {
    const [result] = await db
      .update(rescueRoverSettings)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(rescueRoverSettings.shopId, data.shopId))
      .returning();
    return result;
  }

  const [result] = await db
    .insert(rescueRoverSettings)
    .values(data)
    .returning();
  return result;
}

export async function createCallLog(data: NewCallLog) {
  const db = getDb();
  const [result] = await db
    .insert(rescueRoverCallLogs)
    .values(data)
    .returning();
  return result;
}

export async function getCallLogsByShopId(
  shopId: number,
  options: { limit?: number; offset?: number } = {},
) {
  const db = getDb();
  const { limit = 50, offset = 0 } = options;

  return db.query.rescueRoverCallLogs.findMany({
    where: eq(rescueRoverCallLogs.shopId, shopId),
    orderBy: [desc(rescueRoverCallLogs.createdAt)],
    limit,
    offset,
  });
}

export async function getCallLogById(id: number) {
  const db = getDb();
  return db.query.rescueRoverCallLogs.findFirst({
    where: eq(rescueRoverCallLogs.id, id),
  });
}

export async function getSafetyRules(shopId: number) {
  const db = getDb();
  return db.query.rescueRoverSafetyRules.findMany({
    where: and(
      eq(rescueRoverSafetyRules.enabled, true),
      eq(rescueRoverSafetyRules.shopId, shopId),
    ),
    orderBy: [desc(rescueRoverSafetyRules.priority)],
  });
}

export async function getGlobalSafetyRules() {
  const db = getDb();
  return db.query.rescueRoverSafetyRules.findMany({
    where: and(
      eq(rescueRoverSafetyRules.isGlobal, true),
      eq(rescueRoverSafetyRules.enabled, true),
    ),
    orderBy: [desc(rescueRoverSafetyRules.priority)],
  });
}

export async function getPromptTemplates(shopId: number) {
  const db = getDb();
  return db.query.rescueRoverPromptTemplates.findMany({
    where: and(
      eq(rescueRoverPromptTemplates.shopId, shopId),
      eq(rescueRoverPromptTemplates.enabled, true),
    ),
  });
}

export async function getDefaultPromptTemplates() {
  const db = getDb();
  return db.query.rescueRoverPromptTemplates.findMany({
    where: and(
      eq(rescueRoverPromptTemplates.isDefault, true),
      eq(rescueRoverPromptTemplates.enabled, true),
    ),
  });
}

export async function getVoiceScripts(shopId: number) {
  const db = getDb();
  return db.query.rescueRoverVoiceScripts.findMany({
    where: and(
      eq(rescueRoverVoiceScripts.shopId, shopId),
      eq(rescueRoverVoiceScripts.enabled, true),
    ),
    orderBy: [desc(rescueRoverVoiceScripts.priority)],
  });
}

export async function getContextRules(shopId: number) {
  const db = getDb();
  return db.query.rescueRoverContextRules.findMany({
    where: and(
      eq(rescueRoverContextRules.shopId, shopId),
      eq(rescueRoverContextRules.enabled, true),
    ),
    orderBy: [desc(rescueRoverContextRules.priority)],
  });
}

export async function getRcsLinks(shopId: number) {
  const db = getDb();
  return db.query.rescueRoverRcsLinks.findMany({
    where: and(
      eq(rescueRoverRcsLinks.shopId, shopId),
      eq(rescueRoverRcsLinks.isActive, true),
    ),
  });
}
