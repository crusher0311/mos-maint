import { eq, desc, and, sql, isNull } from "drizzle-orm";
import { getDb } from "../drizzle";
import {
  phoneNumbers,
  groups,
  agentTargets,
  timeEntries,
  cannedMessages,
} from "../schema";

type NewPhoneNumber = typeof phoneNumbers.$inferInsert;
type NewGroup = typeof groups.$inferInsert;
type NewAgentTarget = typeof agentTargets.$inferInsert;
type NewTimeEntry = typeof timeEntries.$inferInsert;
type NewCannedMessage = typeof cannedMessages.$inferInsert;

export async function getPhoneNumbers() {
  const db = getDb();
  return db.query.phoneNumbers.findMany({
    orderBy: [desc(phoneNumbers.createdAt)],
  });
}

export async function getPhoneNumberById(id: number) {
  const db = getDb();
  return db.query.phoneNumbers.findFirst({
    where: eq(phoneNumbers.id, id),
  });
}

export async function createPhoneNumber(data: NewPhoneNumber) {
  const db = getDb();
  const [result] = await db.insert(phoneNumbers).values(data).returning();
  return result;
}

export async function updatePhoneNumber(id: number, data: Partial<NewPhoneNumber>) {
  const db = getDb();
  const [result] = await db
    .update(phoneNumbers)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(phoneNumbers.id, id))
    .returning();
  return result;
}

export async function deletePhoneNumber(id: number) {
  const db = getDb();
  await db.delete(phoneNumbers).where(eq(phoneNumbers.id, id));
}

export async function getGroups() {
  const db = getDb();
  return db.query.groups.findMany({
    orderBy: [desc(groups.createdAt)],
    with: {
      agentTargets: true,
    },
  });
}

export async function getGroupById(id: number) {
  const db = getDb();
  return db.query.groups.findFirst({
    where: eq(groups.id, id),
    with: {
      agentTargets: true,
    },
  });
}

export async function createGroup(data: NewGroup) {
  const db = getDb();
  const [result] = await db.insert(groups).values(data).returning();
  return result;
}

export async function updateGroup(id: number, data: Partial<NewGroup>) {
  const db = getDb();
  const [result] = await db
    .update(groups)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(groups.id, id))
    .returning();
  return result;
}

export async function deleteGroup(id: number) {
  const db = getDb();
  await db.delete(groups).where(eq(groups.id, id));
}

export async function getAgentTargets(groupId?: number) {
  const db = getDb();
  if (groupId) {
    return db.query.agentTargets.findMany({
      where: eq(agentTargets.groupId, groupId),
      orderBy: [desc(agentTargets.createdAt)],
    });
  }
  return db.query.agentTargets.findMany({
    orderBy: [desc(agentTargets.createdAt)],
  });
}

export async function createAgentTarget(data: NewAgentTarget) {
  const db = getDb();
  const [result] = await db.insert(agentTargets).values(data).returning();
  return result;
}

export async function updateAgentTarget(id: number, data: Partial<NewAgentTarget>) {
  const db = getDb();
  const [result] = await db
    .update(agentTargets)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(agentTargets.id, id))
    .returning();
  return result;
}

export async function deleteAgentTarget(id: number) {
  const db = getDb();
  await db.delete(agentTargets).where(eq(agentTargets.id, id));
}

export async function getTimeEntries(options: { status?: "active" | "completed"; limit?: number } = {}) {
  const db = getDb();
  const { status, limit = 100 } = options;
  const conditions = [];
  if (status) {
    conditions.push(eq(timeEntries.status, status));
  }
  return db.query.timeEntries.findMany({
    where: conditions.length > 0 ? and(...conditions) : undefined,
    orderBy: [desc(timeEntries.clockIn)],
    limit,
  });
}

export async function getActiveTimeEntry(agentEmail: string) {
  const db = getDb();
  return db.query.timeEntries.findFirst({
    where: and(
      eq(timeEntries.agentEmail, agentEmail),
      eq(timeEntries.status, "active"),
    ),
  });
}

export async function createTimeEntry(data: NewTimeEntry) {
  const db = getDb();
  const [result] = await db.insert(timeEntries).values(data).returning();
  return result;
}

export async function updateTimeEntry(id: number, data: Partial<NewTimeEntry>) {
  const db = getDb();
  const [result] = await db
    .update(timeEntries)
    .set(data)
    .where(eq(timeEntries.id, id))
    .returning();
  return result;
}

export async function getCannedMessages(activeOnly = false) {
  const db = getDb();
  if (activeOnly) {
    return db.query.cannedMessages.findMany({
      where: eq(cannedMessages.isActive, true),
      orderBy: [desc(cannedMessages.usageCount)],
    });
  }
  return db.query.cannedMessages.findMany({
    orderBy: [desc(cannedMessages.createdAt)],
  });
}

export async function getCannedMessageById(id: number) {
  const db = getDb();
  return db.query.cannedMessages.findFirst({
    where: eq(cannedMessages.id, id),
  });
}

export async function createCannedMessage(data: NewCannedMessage) {
  const db = getDb();
  const [result] = await db.insert(cannedMessages).values(data).returning();
  return result;
}

export async function updateCannedMessage(id: number, data: Partial<NewCannedMessage>) {
  const db = getDb();
  const [result] = await db
    .update(cannedMessages)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(cannedMessages.id, id))
    .returning();
  return result;
}

export async function deleteCannedMessage(id: number) {
  const db = getDb();
  await db.delete(cannedMessages).where(eq(cannedMessages.id, id));
}

export async function incrementCannedMessageUsage(id: number) {
  const db = getDb();
  const [result] = await db
    .update(cannedMessages)
    .set({ usageCount: sql`${cannedMessages.usageCount} + 1` })
    .where(eq(cannedMessages.id, id))
    .returning();
  return result;
}

export async function getAgentLeaderboard() {
  const db = getDb();
  return db
    .select({
      agentName: agentTargets.agentName,
      agentEmail: agentTargets.agentEmail,
      groupId: agentTargets.groupId,
      callsTarget: agentTargets.callsTarget,
      callsActual: agentTargets.callsActual,
      conversionTarget: agentTargets.conversionTarget,
      conversionActual: agentTargets.conversionActual,
      revenueTarget: agentTargets.revenueTarget,
      revenueActual: agentTargets.revenueActual,
    })
    .from(agentTargets)
    .where(eq(agentTargets.isActive, true))
    .orderBy(desc(agentTargets.callsActual));
}
