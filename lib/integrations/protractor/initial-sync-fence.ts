import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import * as progress from "@/lib/data/repositories/protractor-backfill-progress";

type Fence = { db: any; shopId: number; generation: string; revision?: string };
const storage = new AsyncLocalStorage<Fence>();

export class InitialSyncSuperseded extends Error {
  constructor() {
    super("Historical sync connection changed or checkpoint writer is busy.");
  }
}

export function runWithInitialSyncFence<T>(fence: Fence | undefined, work: () => Promise<T>): Promise<T> {
  return fence ? storage.run(fence, work) : work();
}

// A short shop-document mutex bridges shop identity and the canonical
// checkpoint store (which may be PG). Disconnect/reconnect CAS must refuse
// while it is held. Do NOT automatically expire this mutex: a DB write can
// settle late. Operator migrations/recovery must stop the worker and ensure
// its pending DB operations have terminated before clearing this token.
// This fences checkpoint/completion only, not legacy invoice ingestion.
export async function withInitialSyncCheckpointFence<T>(shopId: number, work: () => Promise<T>): Promise<T> {
  const fence = storage.getStore();
  if (!fence) return work();
  if (shopId !== fence.shopId) throw new InitialSyncSuperseded();
  const token = crypto.randomUUID();
  const shops = fence.db.collection("shops");
  const claim = await shops.updateOne({
    shopId,
    integrationProvider: "protractor",
    "protractor.configured": true,
    "protractor.connectionGeneration": fence.generation,
    "protractor.syncRevision": fence.revision ?? { $exists: false },
    "protractor.checkpointWriteToken": { $exists: false },
  }, { $set: { "protractor.checkpointWriteToken": token } });
  if (claim.matchedCount !== 1) throw new InitialSyncSuperseded();
  try {
    return await work();
  } finally {
    await shops.updateOne({ shopId, "protractor.checkpointWriteToken": token }, {
      $unset: { "protractor.checkpointWriteToken": "" },
    });
  }
}

export async function writeProtractorCheckpoint(
  shopId: number, update: Parameters<typeof progress.upsertMerge>[1],
) {
  return withInitialSyncCheckpointFence(shopId, () => progress.upsertMerge(shopId, update));
}

export async function markProtractorBackfillComplete(db: any, shopId: number) {
  const fence = storage.getStore();
  return withInitialSyncCheckpointFence(shopId, async () => {
    const result = await db.collection("shops").updateOne(
      {
        shopId,
        ...(fence ? {
          integrationProvider: "protractor",
          "protractor.configured": true,
          "protractor.connectionGeneration": fence.generation,
          "protractor.syncRevision": fence.revision ?? { $exists: false },
        } : {}),
      },
      { $set: { protractorBackfillComplete: true, protractorBackfillCompletedAt: new Date() } },
    );
    if (fence && result.matchedCount !== 1) throw new InitialSyncSuperseded();
    return result;
  });
}