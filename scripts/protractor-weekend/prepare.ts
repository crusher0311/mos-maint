import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WEEKEND, weekendFrom } from "../../lib/protractor-weekend-policy";
import { isProtractorShopRecord } from "../../lib/integrations/protractor/shop-eligibility";
import { collections, runtime, workersSuspended, fleet, RATE, binding, log } from "./shared";

const day = (t: Date | string | number) => new Date(t).toISOString().slice(0, 10);
const previous = (s: string) => day(Date.parse(s) - 86400000);
export function plannedDays(shopId: number, progress: any, prior: any): string[] {
  const floor = weekendFrom(shopId);
  const coveredThrough = prior?.status === "completed" && prior?.until
    ? previous(prior.until) : progress?.completed && progress.lastRunAt &&
      +new Date(progress.lastRunAt) > 0 ? previous(day(progress.lastRunAt)) : null;
  const result: string[] = [];
  for (let d = previous(WEEKEND.until); d >= floor; d = previous(d)) {
    // Legacy complete proves old walk coverage, not freshness after its last run.
    if (coveredThrough && d < coveredThrough) break;
    // Incomplete legacy walks have already covered cursor..lastRun; keep a
    // two-day overlap at both edges. Never infer coverage from an epoch marker.
    if (!progress?.completed && progress?.currentChunkEnd && progress?.lastRunAt &&
      +new Date(progress.lastRunAt) > 0 &&
      d > day(+new Date(progress.currentChunkEnd) + 86400000) &&
      d < previous(day(progress.lastRunAt))) continue;
    result.push(d);
  }
  return result;
}
export async function prepare(approved: boolean) {
  runtime(); await workersSuspended();
  const { db, jobs, rates, days } = await collections();
  assert.ok(!await jobs.findOne({ _id: WEEKEND.id }, { maxTimeMS: 5000 }), "Existing campaign: resume, never reset");
  const state = await rates.findOne({ _id: RATE }, { maxTimeMS: 5000 }); fleet(state);
  assert.ok(!state.weekendHistory, "Existing permission must not be reset");
  const shops = await db.collection("shops").find({ "protractor.configured": true },
    { maxTimeMS: 5000 }).limit(201).toArray();
  assert.ok(shops.length <= 200);
  const progress = await db.collection("backfill_progress").find({}, { maxTimeMS: 5000 }).limit(301).toArray();
  assert.ok(progress.length <= 300);
  const evidence = new Map<number, Date[]>();
  // Seven individually bounded, index-backed windows, with no provider reads.
  // Truncation only reduces candidates; live inactivity is checked separately.
  for (let i = 0; i < 7; i++) {
    const end = new Date(Date.now() - i * 86400000), start = new Date(+end - 86400000);
    const rows = await db.collection("protractor_callback_events").find({
      method: { $in: ["GET", "POST"] }, receivedAt: { $gte: start, $lt: end },
      objectType: { $in: ["WorkOrder", "ServiceItem"] },
    }, { projection: { shopId: 1, receivedAt: 1 }, maxTimeMS: 7000 })
      .hint("method_1_receivedAt_-1").limit(20000).toArray();
    for (const row of rows) {
      const id = Number(row.shopId), list = evidence.get(id) ?? [];
      // Keep three per UTC day rather than retaining every customer event.
      if (list.filter(d => day(d) === day(row.receivedAt)).length < 3) list.push(row.receivedAt);
      evidence.set(id, list);
    }
  }
  const entries = [];
  for (const shop of shops) {
    if (!isProtractorShopRecord(shop) || ["canceled", "cancelled"].includes(String(shop.status))) continue;
    const shopId = Number(shop.shopId);
    const b = await binding(shopId);
    const priorId = shopId === 538 ? "shop538-history-2026-10-08" :
      shopId === 457 ? "avid-history-2026-10-13" : undefined;
    const prior = priorId ? await jobs.findOne({ _id: priorId }, { maxTimeMS: 5000 }) : null;
    let pendingDays = plannedDays(shopId, progress.find(p => Number(p.shopId) === shopId), prior);
    if (shopId === 457 && prior) {
      const completeDays = await days.find({
        _id: { $in: pendingDays.map(d => `${priorId}:${d}`) }, complete: true,
      }, { projection: { day: 1 }, maxTimeMS: 5000 }).toArray();
      const done = new Set(completeDays.map(d => d.day));
      pendingDays = pendingDays.filter(d => !done.has(d));
    }
    entries.push({ shopId, bindingDigest: b.digest, pendingDays, callbackEvidence: evidence.get(shopId) ?? [],
      priorJobId: priorId ?? null });
  }
  const preview = entries.map(s => ({ shopId: s.shopId, pendingDays: s.pendingDays.length,
    callbackEvidenceDays: new Set(s.callbackEvidence.map(day)).size }));
  log("weekend_inventory", { approved, shops: preview });
  if (!approved) return;
  await jobs.insertOne({ _id: WEEKEND.id, runId: randomUUID(), canaryGeneration: state.canary.generation,
    status: "prepared", stopped: false, expiresAt: new Date(WEEKEND.end), createdAt: new Date(),
    shops: entries, mode: "missing_history_only", maxRequests: WEEKEND.maxRequests });
  log("weekend_prepared", { shops: entries.length, cutoff: WEEKEND.end });
}
