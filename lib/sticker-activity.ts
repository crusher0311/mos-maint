import { createHash, randomUUID } from "node:crypto";
import type { Db, ClientSession } from "mongodb";

export const stickerActivityDeps: { startSession: () => Promise<ClientSession> } = {
  startSession: async () => (await (await import("./mongo")).getMongoClient()).startSession(),
};

export type StickerEvidence = "handoff" | "printer-ack" | "legacy-generation";
export function validPrintAction(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(value);
}
export function printEventId(shopId: number, action: string): string {
  return createHash("sha256").update(`sticker|${shopId}|${action}`).digest("hex");
}
export function validatePrintIntent(body: { printActionId?: unknown; printIntent?: unknown }): boolean {
  return (body.printActionId === undefined || validPrintAction(body.printActionId)) &&
    (body.printIntent === undefined || ["print", "queue", "sample"].includes(String(body.printIntent))) &&
    (body.printIntent !== "print" || validPrintAction(body.printActionId));
}

export interface StickerSupply {
  enabled: boolean;
  capacity: number;
  threshold: number;
  used: number;
  revision: string;
  low: boolean;
}
export async function readStickerSupply(db: Db, shopId: number): Promise<StickerSupply | null> {
  const row = await db.collection<any>("sticker_supply").findOne({ _id: String(shopId) }, { maxTimeMS: 2000 });
  return row ? {
    enabled: row.enabled, capacity: row.capacity, threshold: row.threshold,
    used: row.used, revision: row.revision, low: row.enabled && row.used >= row.threshold,
  } : null;
}

/**
 * One transaction joins the immutable, shop-bound event to roll consumption.
 * The built-in _id index provides deduplication: no runtime index installation.
 * Retry of an event after a reset never consumes the replacement roll.
 * Older clients remain generation-only evidence and cannot consume roll estimates.
 */
export async function recordStickerActivity(
  db: Db, shopId: number, action: string | undefined, evidence: StickerEvidence,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const id = printEventId(shopId, action ?? randomUUID());
  const session = await stickerActivityDeps.startSession();
  try {
    await session.withTransaction(async () => {
      const events = db.collection<any>("sticker_generations");
      if (await events.findOne({ _id: id }, { session })) return;
      await events.insertOne({
        ...metadata, _id: id, shopId, generatedAt: new Date(), evidence,
      }, { session });
      if (evidence !== "legacy-generation") {
        await db.collection<any>("sticker_supply").updateOne(
          { _id: String(shopId), enabled: true },
          { $inc: { used: 1 } }, { session },
        );
      }
    }, { maxCommitTimeMS: 3000 });
  } catch (error: any) {
    // Concurrent insert of the same identity may lose the unique-key race.
    // A committed matching row proves its consumption committed with it.
    if (error?.code !== 11000 || !await db.collection<any>("sticker_generations").findOne({ _id: id })) throw error;
  } finally {
    await session.endSession();
  }
}

export function supplyConfiguration(input: any): { enabled: boolean; capacity: number; threshold: number } {
  const { enabled, capacity } = input;
  const threshold = input.threshold ?? Math.ceil(capacity * 0.95);
  if (typeof enabled !== "boolean" || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100000 ||
      !Number.isSafeInteger(threshold) || threshold < 1 || threshold > capacity) {
    throw new Error("Capacity must be 1–100,000 labels; warning threshold must be 1–capacity.");
  }
  return { enabled, capacity, threshold };
}

export async function changeStickerSupply(db: Db, shopId: number, input: any): Promise<boolean> {
  const col = db.collection<any>("sticker_supply");
  const revision = randomUUID();
  if (input.operation === "reset") {
    if (typeof input.revision !== "string") throw new Error("Current roll revision required.");
    const result = await col.updateOne(
      { _id: String(shopId), revision: input.revision, enabled: true },
      { $set: { revision, used: 0, startedAt: new Date() } },
    );
    return result.matchedCount === 1;
  }
  if (input.operation !== "configure") throw new Error("Invalid operation.");
  const config = supplyConfiguration(input);
  if (input.revision === null) {
    try {
      await col.insertOne({ _id: String(shopId), ...config, revision, used: 0, startedAt: new Date() });
      return true;
    } catch (error: any) { if (error?.code === 11000) return false; throw error; }
  }
  if (typeof input.revision !== "string") throw new Error("Current roll revision required.");
  // A re-enable is an explicit new estimation period. Editing capacity never
  // resets usage. Pipeline updates serialize against event increments/resets.
  const result = await col.updateOne(
    { _id: String(shopId), revision: input.revision },
    [{ $set: {
      ...config, revision,
      used: { $cond: [{ $and: [config.enabled, { $not: ["$enabled"] }] }, 0, "$used"] },
      startedAt: { $cond: [{ $and: [config.enabled, { $not: ["$enabled"] }] }, "$$NOW", "$startedAt"] },
    } }],
  );
  return result.matchedCount === 1;
}
