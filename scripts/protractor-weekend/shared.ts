import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { getDb } from "../../lib/mongo";
import { WEEKEND, callbackQuietEvidence, weekendShopCancelled } from "../../lib/protractor-weekend-policy";
import { isProtractorShopRecord } from "../../lib/integrations/protractor/shop-eligibility";
import { historyBindingDigest } from "../../lib/integrations/protractor/shop-history-context";
import { resolveProtractorConfig } from "../../lib/integrations/protractor/client";

export const RATE = "protractor-physical-transport-v1";
export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const log = (event: string, data: object = {}) =>
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...data }));
export function runtime() {
  assert.ok(process.env.RENDER && !process.env.REPLIT_DEV_DOMAIN && !process.env.REPL_ID,
    "History runner requires production Render");
  assert.equal(process.env.NORMALIZED_INGEST_WRITE_CONCURRENCY, "1");
  assert.ok(Date.now() >= Date.parse(WEEKEND.start) && Date.now() < Date.parse(WEEKEND.end) - 120000,
    "Campaign window ended");
}
export async function collections() {
  const db = await getDb();
  return {
    db, rates: db.collection<any>("api_rate_limits"),
    jobs: db.collection<any>("operator_history_import_jobs"),
    pages: db.collection<any>("operator_history_import_pages"),
    receipts: db.collection<any>("operator_history_import_receipts"),
    days: db.collection<any>("operator_history_import_days"),
  };
}
export function fleet(state: any) {
  assert.ok(state?.operatorStop?.active === false && state.canary?.mode === "live" &&
    state.canary.requiresRelay === true && state.canary.scope === "callbacks_and_interactive" &&
    state.canary.workersSuspendedConfirmed === true && !state.canary.endedBy,
  "Fleet protection changed");
}
export async function workersSuspended() {
  assert.equal(process.env.WORKER_SCHEDULE_DISABLED, "true");
  const response = await fetch("https://api.render.com/v1/services?limit=100", {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY_PROD}` },
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, "Cannot verify general workers");
  const services = (await response.json()).map((r: any) => r.service);
  for (const name of ["backfill-drain-worker", "mos-maint-background-v2"]) {
    const matches = services.filter((s: any) => s.name === name);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].suspended, "suspended", "General workers must remain suspended");
  }
}
export async function binding(shopId: number) {
  const { db } = await collections();
  const matches = await db.collection("shops").find({ shopId: { $in: [shopId, String(shopId)] } },
    { maxTimeMS: 5000 }).limit(2).toArray();
  assert.equal(matches.length, 1, "Ambiguous or missing shop identity");
  const shop = matches[0];
  assert.ok(shop && !weekendShopCancelled({ status: shop.status, billing: shop.billing }) &&
    isProtractorShopRecord(shop), "Shop no longer eligible");
  const config = await resolveProtractorConfig(shopId);
  assert.ok(config.configured && config.connectionId);
  return { config, digest: historyBindingDigest(shopId, config.connectionId) };
}
/** Indexed bounded reads. A capped live window cannot establish inactivity. */
export async function recentActivity(now = new Date()) {
  const { db } = await collections();
  const rows = await db.collection("protractor_callback_events").find({
    method: { $in: ["GET", "POST"] }, receivedAt: { $gte: new Date(+now - 2 * 3600000) },
  }, { projection: { shopId: 1, receivedAt: 1, processed: 1, objectType: 1 }, maxTimeMS: 5000 })
    .hint("method_1_receivedAt_-1").limit(10000).toArray();
  assert.ok(rows.length < 10000, "Activity window capped");
  const active = new Set(rows.filter(r => +now - +r.receivedAt < WEEKEND.quietMs)
    .map(r => Number(r.shopId)));
  const delayed = rows.filter(r => r.objectType !== "Contact" && !r.processed &&
    +now - +r.receivedAt > 5 * 60000).length;
  return { active, delayed, checkedAt: now };
}
export async function assertOwner(owner: string, shopId?: number) {
  runtime();
  const { jobs, rates } = await collections();
  const [job, state] = await Promise.all([
    jobs.findOne({ _id: WEEKEND.id, owner, stopped: false, status: "running",
      leaseUntil: { $gt: new Date() } }, { maxTimeMS: 5000 }),
    rates.findOne({ _id: RATE }, { maxTimeMS: 5000 }),
  ]);
  fleet(state);
  assert.ok(job && state.weekendHistory?.owner === owner &&
    state.weekendHistory.runnerLeaseUntil > new Date() &&
    state.weekendHistory.runId === job.runId &&
    state.weekendHistory.canaryGeneration === state.canary.generation, "Campaign ownership lost");
  if (shopId !== undefined) {
    assert.equal(state.weekendHistory.shopId, shopId);
    assert.equal(state.weekendHistory.stopped, false);
    const b = await binding(shopId);
    assert.equal(b.digest, state.weekendHistory.bindingDigest);
    const entry = job.shops.find((s: any) => s.shopId === shopId);
    assert.ok(entry && callbackQuietEvidence(entry.callbackEvidence.map((d: string) => new Date(d)), new Date()),
      "Callback health evidence missing or expired");
    const activity = await recentActivity();
    assert.ok(!activity.active.has(shopId) && activity.delayed < 25, "Live traffic takes priority");
  }
  return { job, state };
}
