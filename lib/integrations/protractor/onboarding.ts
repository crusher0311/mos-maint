import crypto from "node:crypto";
import * as progress from "@/lib/data/repositories/protractor-backfill-progress";
import { countServiceItemsByShop } from "@/lib/data/repositories/protractor-service-items";
import { getEffectiveProtractorOutboundPolicy } from "./client";
import { getProtractorOperatorStop } from "@/lib/data/repositories/api-usage";
import { runWithInitialSyncFence } from "./initial-sync-fence";

export class ConnectionConflict extends Error {
  constructor() {
    super("This shop has a different provider or Protractor connection. Contact support for a controlled data migration before changing the connection.");
  }
}

export function connectionBinding(connectionId: string, apiKey: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([
    connectionId.trim().toLowerCase(), apiKey.trim().toLowerCase(),
  ])).digest("hex");
}

export function storedBinding(shop: any): string | undefined {
  if (shop?.protractor?.connectionGeneration) return shop.protractor.connectionGeneration;
  const id = shop?.protractorConnectionId ?? shop?.protractor?.connectionId;
  const key = shop?.protractorApiKey ?? shop?.protractor?.apiKey;
  return id && key ? connectionBinding(id, key) : undefined;
}

export async function saveProtractorConnection(
  db: any, shopId: number, connectionId: string, apiKey: string, locations?: any[],
) {
  const shops = db.collection("shops");
  const shop = await shops.findOne({ shopId });
  // Authenticated sessions must resolve to an existing shop. Never upsert a
  // shop from a stale session or allow a competing POST to overwrite a binding.
  if (!shop) throw new ConnectionConflict();
  const generation = connectionBinding(connectionId, apiKey);
  const previous = storedBinding(shop);
  const provider = shop.integrationProvider?.trim().toLowerCase();
  if ((provider && provider !== "protractor") || (previous && previous !== generation) ||
      (!previous && (shop.tekmetric?.shopId || shop.tekmetricShopId || shop.shopware?.shopId ||
        shop.protractor?.configuredAt || shop.protractor?.initialSyncState))) {
    throw new ConnectionConflict();
  }
  const checkpoint = await progress.findByShop(shopId);
  const workerActive = checkpoint?.inProgress === true &&
    Date.now() - new Date(checkpoint.lastActivityAt || 0).getTime() < 30 * 60_000;
  const initialSyncState = shop.protractorBackfillComplete === true || checkpoint?.completed === true
    ? "complete"
    : workerActive ? "running" : shop.protractor?.initialSyncState === "failed" ? "failed" : "pending";
  const savedSyncError = initialSyncState === "failed" ? shop.protractor?.initialSyncError ?? null : null;
  const update = await shops.updateOne({
    shopId,
    // Exact snapshot CAS protects concurrent provider/credential changes.
    integrationProvider: shop.integrationProvider ?? { $exists: false },
    protractorConnectionId: shop.protractorConnectionId ?? { $exists: false },
    protractorApiKey: shop.protractorApiKey ?? { $exists: false },
    "protractor.connectionGeneration": shop.protractor?.connectionGeneration ?? { $exists: false },
    "protractor.connectionId": shop.protractor?.connectionId ?? { $exists: false },
    "protractor.apiKey": shop.protractor?.apiKey ?? { $exists: false },
    "protractor.checkpointWriteToken": { $exists: false },
  }, { $set: {
    protractorConnectionId: connectionId,
    protractorApiKey: apiKey,
    protractorWebhookToken: shop.protractorWebhookToken || crypto.randomBytes(16).toString("hex"),
    integrationProvider: "protractor",
    "protractor.configured": true,
    "protractor.configuredAt": shop.protractor?.configuredAt || new Date(),
    "protractor.connectionGeneration": generation,
    "protractor.locations": locations || [],
    "protractor.updateWorkOrderPackage": shop.protractor?.updateWorkOrderPackage ?? true,
    "protractor.updateWorkOrderLine": shop.protractor?.updateWorkOrderLine ?? true,
    "protractor.initialSyncState": initialSyncState,
    "protractor.initialSyncError": savedSyncError,
    updatedAt: new Date(),
  } });
  if (update.matchedCount !== 1) throw new ConnectionConflict();

  // Durable discovery through the canonical repository; no new queue, fleet
  // switch, cleanup, or request-lifetime worker. Preserve every existing cursor.
  // A crash here is recoverable: controlled workers also discover configured
  // shops without a progress row.
  let initialSyncError: string | null = savedSyncError;
  if (initialSyncState !== "complete") {
    try {
      await progress.upsertMerge(shopId, {
        setOnInsert: { startedAt: new Date(), completed: false, lastRunAt: new Date(0) },
      });
    } catch {
      // The shop save above is the commit point. Discovery can recover from
      // the configured shop alone, so an auxiliary cursor-write failure must
      // not turn an acknowledged connection into an apparent save failure.
      // Do not attempt another potentially failing write or log DB errors
      // (which can contain connection strings, tokens, or query parameters).
      initialSyncError ||= "Connection saved. Historical sync remains queued; background worker discovery will retry.";
      console.warn(JSON.stringify({
        event: "protractor_onboarding_progress_discovery_deferred",
        shopId,
        initialSyncState,
      }));
    }
  }
  return {
    initialSyncState,
    initialSyncError,
    initialSyncVehicles: shop.protractor?.initialSyncVehicles ?? null,
  };
}

export async function initialSyncStatus(shop: any, shopId: number) {
  let state = shop?.protractor?.initialSyncState ??
    (shop?.protractorBackfillComplete === true ? "complete" : "pending");
  let error = shop?.protractor?.initialSyncError ?? null;
  if (state === "running") {
    const checkpoint = await progress.findByShop(shopId);
    const lastActivity = new Date(checkpoint?.lastActivityAt || shop?.protractor?.initialSyncStartedAt || 0).getTime();
    if (!checkpoint?.inProgress || !lastActivity || Date.now() - lastActivity > 30 * 60_000) {
      state = "pending";
      error = "Historical sync is waiting for an approved background worker to resume.";
    }
  }
  return {
    initialSyncState: state,
    initialSyncError: error,
    initialSyncVehicles: shop?.protractor?.initialSyncVehicles ?? null,
  };
}

export class BackgroundSyncRestricted extends Error {
  constructor() {
    super("Historical sync is queued until background Protractor access is approved.");
  }
}

export async function assertBackgroundSyncAllowed(): Promise<void> {
  let policy;
  let stop;
  try {
    policy = await getEffectiveProtractorOutboundPolicy();
    stop = await getProtractorOperatorStop();
  } catch {
    throw new BackgroundSyncRestricted();
  }
  // A shared live/timed generation is foreground/callback-only even on a
  // replica lacking staging env flags. Never interpret allowInteractive as
  // worker permission.
  if (stop?.active === true || stop?.canary != null ||
      !policy.allowed || policy.callbackOnly || policy.requireTimedTrial ||
      policy.allowInteractive || policy.callbackNotBeforeMs != null) {
    throw new BackgroundSyncRestricted();
  }
}

type SyncResult = { chunksProcessed: number; totalJobsIndexed: number; complete: boolean; error?: string };

export async function runStagedInitialSync(
  db: any, shopId: number, work: (staged: boolean) => Promise<SyncResult>,
): Promise<SyncResult> {
  const shops = db.collection("shops");
  const shop = await shops.findOne({ shopId });
  const generation = shop?.protractor?.connectionGeneration;
  const revision = shop?.protractor?.syncRevision;
  const filter = { shopId, "protractor.connectionGeneration": generation, "protractor.syncRevision": revision ?? { $exists: false }, "protractor.configured": true, integrationProvider: "protractor" };
  const staged = !!generation;
  const empty = { chunksProcessed: 0, totalJobsIndexed: 0, complete: false };
  if (staged && (shop.protractor.configured !== true || shop.integrationProvider !== "protractor" ||
      connectionBinding(shop.protractorConnectionId || "", shop.protractorApiKey || "") !== generation)) {
    return { ...empty, error: "Protractor connection changed or disconnected" };
  }
  try {
    await assertBackgroundSyncAllowed();
    if (staged) {
      const claimed = await shops.updateOne(filter, { $set: {
        "protractor.initialSyncState": "running",
        "protractor.initialSyncStartedAt": new Date(),
        "protractor.initialSyncError": null,
      } });
      if (claimed.matchedCount !== 1) return { ...empty, error: "Protractor connection changed" };
    }
    const result = await runWithInitialSyncFence(
      staged ? { db, shopId, generation, revision } : undefined,
      () => work(staged),
    );
    if (staged && result.error !== "Already in progress") {
      // Never call a partial chunk/batch complete.
      const vehicles = await countServiceItemsByShop(shopId);
      await shops.updateOne(filter, { $set: {
        "protractor.initialSyncState": result.error ? "failed" : result.complete ? "complete" : "pending",
        "protractor.initialSyncError": result.error || null,
        "protractor.initialSyncVehicles": vehicles,
        ...(result.complete ? { "protractor.initialSyncFinishedAt": new Date() } : {}),
      } });
    }
    return result;
  } catch (error: any) {
    const restricted = error instanceof BackgroundSyncRestricted;
    const retainFailure = restricted && shop?.protractor?.initialSyncState === "failed";
    if (staged) await shops.updateOne(filter, { $set: {
      "protractor.initialSyncState": retainFailure ? "failed" : restricted ? "pending" : "failed",
      "protractor.initialSyncError": retainFailure ? shop.protractor.initialSyncError ?? error.message : error.message,
    } });
    return { ...empty, error: error.message };
  }
}