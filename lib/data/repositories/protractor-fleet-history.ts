import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/mongo";
import * as progressRepo from "@/lib/data/repositories/protractor-backfill-progress";
import { isProtractorShopRecord } from "@/lib/integrations/protractor/shop-eligibility";
import { FLEET_HISTORY_KEY, fleetShopBinding, withFleetHistory } from "@/lib/integrations/protractor/fleet-history-context";
import { fleetHistoryDefaults, fleetHistoryWindow, validateFleetHistoryConfig, type FleetHistoryConfig, type FleetHistoryPermit } from "@/lib/integrations/protractor/fleet-history-policy";

const project = { shopId: 1, name: 1, timezone: 1, status: 1, billing: 1, integrationProvider: 1,
  "protractor.configured": 1, "protractor.connectionGeneration": 1,
  "protractor.accountBinding": 1, "protractor.connectionId": 1, "protractor.apiKey": 1,
  "protractor.historyControl": 1, "protractor.checkpointWriteToken": 1,
  protractorApiKey: 1, protractorConnectionId: 1 };
export const __fleetHistoryDeps = {
  getDb, findProgressForShops: progressRepo.findProgressForShops, findByShop: progressRepo.findByShop,
  runBackfill: async (shopId: number) => {
    const { runProtractorBackfill } = await import("@/lib/integrations/protractor/sync");
    return runProtractorBackfill(shopId, { singlePass: true, maxChunks: 1 });
  },
};
export async function readFleetHistoryContext(shopId: number) {
  const db = await __fleetHistoryDeps.getDb();
  const [state, rows] = await Promise.all([
    db.collection<any>("api_rate_limits").findOne({ _id: FLEET_HISTORY_KEY }, { maxTimeMS: 2000 }),
    db.collection("shops").find({ shopId: { $in: [shopId, String(shopId)] } } as any,
      { projection: project }).maxTimeMS(2000).limit(2).toArray(),
  ]);
  return { state, rows };
}
export async function renewFleetHistoryGrant(permit: FleetHistoryPermit) {
  const db = await __fleetHistoryDeps.getDb();
  return db.collection<any>("api_rate_limits").updateOne({
    _id: FLEET_HISTORY_KEY, "fleetHistoryGrant.owner": permit.owner,
    "fleetHistoryGrant.shopId": permit.shopId, "fleetHistoryConfig.revision": permit.revision,
    "fleetHistoryConfig.enabled": true, "operatorStop.active": false,
    "fleetHistoryGrant.expiresAt": { $gt: new Date() },
    "fleetHistoryRunner.owner": permit.owner, "fleetHistoryRunner.expiresAt": { $gt: new Date() },
  }, { $set: { "fleetHistoryGrant.expiresAt": new Date(Date.now() + 60000) } });
}
export async function fleetHistorySnapshot() {
  const db = await __fleetHistoryDeps.getDb();
  const [state, shops] = await Promise.all([
    db.collection<any>("api_rate_limits").findOne({ _id: FLEET_HISTORY_KEY }, { maxTimeMS: 2000 }),
    db.collection("shops").find({ "protractor.configured": true }, { projection: project }).limit(2001).maxTimeMS(3000).toArray(),
  ]);
  if (shops.length > 2000) throw new Error("Fleet inventory exceeds safety limit");
  const config = state?.fleetHistoryConfig ? validateFleetHistoryConfig(state.fleetHistoryConfig) : fleetHistoryDefaults();
  const ids = shops.map(s => Number(s.shopId));
  if (new Set(ids).size !== ids.length) throw new Error("Ambiguous fleet shop identities");
  const progress = await __fleetHistoryDeps.findProgressForShops(ids);
  return { db, state, shops, config, progress };
}
function completeFor(shop: any, progress: any, config: FleetHistoryConfig): boolean {
  if (!progress?.completed) return false;
  const oldest = new Date(); oldest.setFullYear(oldest.getFullYear() - config.horizonYears);
  return !!progress.currentChunkEnd && +new Date(progress.currentChunkEnd) <= +oldest;
}
export async function fleetHistoryStatus() {
  const { state, shops, config, progress } = await fleetHistorySnapshot();
  return {
    config,
    runtime: { active: !!state?.fleetHistoryGrant && +new Date(state.fleetHistoryGrant.expiresAt) > Date.now(),
      shopId: state?.fleetHistoryGrant?.shopId ?? null, lastOutcome: state?.fleetHistoryLastOutcome ?? null },
    shops: shops.filter(isProtractorShopRecord).map(shop => {
      const p = progress.find((p: any) => Number(p.shopId) === Number(shop.shopId));
      const completed = completeFor(shop, p, config);
      const window = fleetHistoryWindow(config, shop);
      let identityReady = true;
      try { identityReady = fleetShopBinding(shop) === shop.protractor?.connectionGeneration; } catch { identityReady = false; }
      const reason = !identityReady ? "connection_review_required" : state?.operatorStop?.active ? "emergency_stop" :
        state?.canary?.mode !== "live" || state?.canary?.endedBy ? "transport_unavailable" :
        !window.allowed ? window.reason : completed ? "complete" :
        state?.fleetHistoryGrant?.shopId === Number(shop.shopId) && +new Date(state.fleetHistoryGrant.expiresAt) > Date.now() ? "running" : "queued";
      return { shopId: Number(shop.shopId), name: shop.name || String(shop.shopId), status: reason, reason,
        completed, paused: !!shop.protractor?.historyControl?.paused, lastError: shop.protractor?.historyControl?.lastError ?? null };
    }),
  };
}
export async function saveFleetHistoryConfig(input: unknown, confirmedHours: boolean) {
  const config = validateFleetHistoryConfig(input);
  if (confirmedHours !== true) throw new Error("Business hours must be explicitly confirmed");
  const db = await __fleetHistoryDeps.getDb();
  const revision = randomUUID();
  const result = await db.collection<any>("api_rate_limits").updateOne({
    _id: FLEET_HISTORY_KEY,
    ...(config.revision === "initial" ? { fleetHistoryConfig: { $exists: false } } : { "fleetHistoryConfig.revision": config.revision }),
  }, { $set: { fleetHistoryConfig: { ...config, revision }, fleetHistoryConfiguredAt: new Date() },
    $unset: { fleetHistoryGrant: "" } }, { upsert: false });
  if (result.matchedCount !== 1) throw new Error("Settings changed or transport is not initialized; reload before saving");
  return { ...config, revision };
}
export async function controlFleetHistory(shopId: number, action: string) {
  if (!Number.isSafeInteger(shopId) || shopId < 1 || !["pause", "resume", "queue", "retry"].includes(action)) throw new Error("Invalid history action");
  const db = await __fleetHistoryDeps.getDb();
  const shops = db.collection("shops");
  const rows = await shops.find({ shopId: { $in: [shopId, String(shopId)] } } as any).maxTimeMS(2000).limit(2).toArray();
  if (rows.length !== 1 || !isProtractorShopRecord(rows[0])) throw new Error("Shop is not uniquely connected to Protractor");
  const result = await shops.updateOne({ _id: rows[0]._id, "protractor.connectionGeneration": rows[0].protractor?.connectionGeneration }, {
    $set: { "protractor.historyControl.paused": action === "pause", "protractor.historyControl.requestedAt": new Date() },
    ...(action === "retry" ? { $unset: { "protractor.historyControl.retryAfter": "", "protractor.historyControl.lastError": "" } } : {}),
  });
  if (!result.matchedCount) throw new Error("Connection changed; reload before retrying");
  // Invalidate at the same physical-admission document, without clearing the
  // runner lease or a checkpoint. A committed pause blocks later dispatches.
  if (action === "pause") await db.collection<any>("api_rate_limits").updateOne(
    { _id: FLEET_HISTORY_KEY, "fleetHistoryGrant.shopId": shopId }, { $unset: { fleetHistoryGrant: "" } });
  return { ok: true, queued: action !== "pause" };
}

/** Called only by the dedicated worker, never in the interactive web process. */
export async function runFleetHistoryTick() {
  const snap = await fleetHistorySnapshot();
  const { db, state, config, progress } = snap;
  if (!config.enabled || state?.operatorStop?.active !== false || state?.canary?.mode !== "live" || state?.canary?.endedBy)
    return { processed: 0, reason: "disabled_or_transport_unavailable" };
  const rates = db.collection<any>("api_rate_limits");
  const owner = randomUUID();
  const lease = await rates.updateOne({ _id: FLEET_HISTORY_KEY, $or: [
    { fleetHistoryRunner: { $exists: false } }, { "fleetHistoryRunner.expiresAt": { $lt: new Date() } },
  ] }, { $set: { fleetHistoryRunner: { owner, expiresAt: new Date(Date.now() + 120000) } } });
  if (!lease.matchedCount) return { processed: 0, reason: "another_worker" };
  let lost = false, busy = false;
  const heartbeat = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      const r = await rates.updateOne({ _id: FLEET_HISTORY_KEY, "fleetHistoryRunner.owner": owner,
        "fleetHistoryRunner.expiresAt": { $gt: new Date() } }, { $set: { "fleetHistoryRunner.expiresAt": new Date(Date.now() + 120000) } });
      if (!r.matchedCount) lost = true;
    } catch { lost = true; } finally { busy = false; }
  }, 20000);
  let processed = 0;
  try {
    const candidates = snap.shops.filter(isProtractorShopRecord).filter(s => {
      try { return fleetShopBinding(s) === s.protractor?.connectionGeneration; } catch { return false; }
    }).filter(s => fleetHistoryWindow(config, s).allowed)
      .filter(s => !completeFor(s, progress.find((p: any) => Number(p.shopId) === Number(s.shopId)), config))
      .sort((a, b) => (+new Date(a.protractor?.historyControl?.lastAttemptAt || 0)) - (+new Date(b.protractor?.historyControl?.lastAttemptAt || 0)));
    for (const shop of candidates.slice(0, config.maxShopsPerTick)) {
      if (lost) break;
      const p = await __fleetHistoryDeps.findByShop(Number(shop.shopId));
      // Let the canonical engine reclaim only demonstrably stale leases through
      // its existing atomic claim. Never clear a lease or checkpoint marker.
      const activity = +new Date(p?.lastActivityAt || p?.lastAttemptedAt || 0);
      if ((p?.inProgress && (!activity || !Number.isFinite(activity) || activity > Date.now() - 30 * 60000)) ||
        Object.prototype.hasOwnProperty.call(shop.protractor || {}, "checkpointWriteToken")) continue;
      const start = Date.now();
      await db.command({ ping: 1, maxTimeMS: 2000 }, { timeoutMS: 2500 });
      if (Date.now() - start > 1000) break;
      const permit = { owner, shopId: Number(shop.shopId), revision: config.revision,
        generation: state.canary.generation, binding: fleetShopBinding(shop), horizonYears: config.horizonYears };
      const grant = await rates.updateOne({ _id: FLEET_HISTORY_KEY, "fleetHistoryRunner.owner": owner,
        "fleetHistoryRunner.expiresAt": { $gt: new Date() }, "fleetHistoryConfig.enabled": true,
        "fleetHistoryConfig.revision": config.revision, "operatorStop.active": false, "canary.generation": permit.generation,
      }, { $set: { fleetHistoryGrant: { ...permit, expiresAt: new Date(Date.now() + 60000), consumed: 0 } } });
      if (!grant.matchedCount) break;
      const filter = { _id: shop._id, "protractor.connectionGeneration": shop.protractor?.connectionGeneration };
      await db.collection("shops").updateOne(filter, { $set: { "protractor.historyControl.lastAttemptAt": new Date() } });
      let outcome = "paused";
      try {
        const result = await withFleetHistory(permit, () => __fleetHistoryDeps.runBackfill(permit.shopId));
        outcome = result.error ? "retry_backoff" : result.complete ? "complete" : "queued";
      } catch { outcome = "retry_backoff"; }
      const failures = Math.min(8, Number(shop.protractor?.historyControl?.failures || 0) + 1);
      await db.collection("shops").updateOne(filter, { $set: {
        "protractor.historyControl.lastOutcome": outcome,
        "protractor.historyControl.lastError": outcome === "retry_backoff" ? "History pass interrupted; progress retained" : null,
        "protractor.historyControl.failures": outcome === "retry_backoff" ? failures : 0,
        "protractor.historyControl.retryAfter": new Date(Date.now() + (outcome === "retry_backoff" ? Math.min(3600000, 60000 * 2 ** failures) : 60000)),
      } });
      await rates.updateOne({ _id: FLEET_HISTORY_KEY, "fleetHistoryRunner.owner": owner },
        { $unset: { fleetHistoryGrant: "" }, $set: { fleetHistoryLastOutcome: outcome } });
      processed++;
    }
    return { processed };
  } finally {
    clearInterval(heartbeat);
    await rates.updateOne({ _id: FLEET_HISTORY_KEY, "fleetHistoryRunner.owner": owner }, { $unset: { fleetHistoryRunner: "", fleetHistoryGrant: "" } });
  }
}
