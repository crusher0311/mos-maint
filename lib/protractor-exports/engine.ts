import { randomUUID } from "node:crypto";
import { COVERAGE, MAX_BODY_BYTES, dueDate, snapshotHash, type ExportConfig, type Snapshot } from "./contract";
import { authorizeShop } from "./authorization";
import { sourcePage } from "./sources";
import { collections, getConfig, stateId, type ExportState, type Pending } from "./store";
import { deliver, revealSecret } from "./transport";

export const engineDependencies = {
  collections, config: getConfig, authorize: authorizeShop, source: sourcePage,
  send: deliver, secret: revealSecret, now: () => new Date(),
  enabled: () => process.env.PROTRACTOR_EXPORTS_ENABLED === "1",
};
export function envelope(config: ExportConfig, state: ExportState, records: Snapshot[], final: boolean, deliveryId: string) {
  return JSON.stringify({
    schemaVersion: "mos.protractor.snapshots.v1", deliveryId,
    enterpriseId: config._id, shopId: state.shopId, provider: "protractor",
    window: { date: state.window, timeZone: config.timeZone, startedAt: state.startedAt,
      previousCompletedDate: state.completedWindow ?? null },
    kind: final ? "window_complete" : "snapshots",
    coverage: { ...COVERAGE, ...state.coverage,
      incomplete: state.coverage.missing > 0 || state.coverage.oversized > 0,
      cutoffSemantics: "latest available at collection time; not a historical point-in-time snapshot",
      omittedProviderFields: "DVI and inspection subdocuments",
      initialSnapshot: !state.baselineDone && config.initialSnapshot,
      baselineOnly: !state.baselineDone && !config.initialSnapshot },
    records,
  });
}
/** One bounded page or one delivery per invocation. Durable state is authoritative;
 * BullMQ is only a wake-up mechanism. Every mutation is fenced by a fresh lease. */
export async function processShop(config: ExportConfig, shopId: number, deps = engineDependencies) {
  if (!deps.enabled()) return;
  const c = await deps.collections(), now = deps.now(), id = stateId(config, shopId);
  const lease = randomUUID();
  try {
    await c.states.updateOne({ _id: id }, { $setOnInsert: {
      enterpriseId: config._id, revision: config.revision, shopId,
      entity: "work_order", after: "", baselineDone: false, attempts: 0,
      coverage: { scanned: 0, missing: 0, oversized: 0, mode: "not_collected" },
    } }, { upsert: true });
    const state = await c.states.findOneAndUpdate({
      _id: id, $or: [{ leaseUntil: { $lt: now } }, { leaseUntil: { $exists: false } }],
    }, { $set: { lease, leaseUntil: new Date(now.getTime() + 120_000) } }, { returnDocument: "after" });
    if (!state) return;
    const fence = { _id: id, lease, leaseUntil: { $gt: deps.now() } };
    const save = async (set: any, unset: any = {}) => {
      const result = await c.states.updateOne({ ...fence, leaseUntil: { $gt: deps.now() } },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
      if (result.matchedCount !== 1) throw new Error("lease_lost");
    };
    const authorized = async () => {
      const live = await deps.config(config._id);
      if (!deps.enabled() || !live || live.paused || live.revoked ||
          live.revision !== config.revision || !live.shopIds.includes(shopId)) throw new Error("authorization_paused_or_revoked");
      await deps.authorize(config._id, shopId);
      if (!await c.states.findOne({ ...fence, leaseUntil: { $gt: deps.now() } })) throw new Error("lease_lost");
    };
    try {
      await authorized();
      if (state.failure === "payload_retention_expired" || state.attempts >= 8 ||
          (state.retryAt && state.retryAt > now)) return;
      if (state.pending) {
        const p = state.pending;
        if (!p.acceptedAt && now.getTime() - Date.parse(p.createdAt) > 30 * 86400_000) {
          await save({ failure: "payload_retention_expired", attempts: 8 }, { pending: "" }); return;
        }
        if (!p.acceptedAt) {
          // Check immediately before outbound I/O, including retries.
          await authorized();
          await deps.send(config.destination, deps.secret(config.secret, `${config._id}:${config.revision}`), p.deliveryId, p.body);
          p.acceptedAt = deps.now().toISOString();
          await save({ "pending.acceptedAt": p.acceptedAt });
        }
        // Recovery after acknowledgment never needs to send again. Hashes are
        // idempotent; pending remains until all checkpoint writes finish.
        for (const h of p.hashes) {
          await save({ leaseUntil: new Date(deps.now().getTime() + 120_000) });
          await c.hashes.updateOne({ _id: `${id}_${h.key}` },
            { $set: { hash: h.hash, updatedAt: deps.now() } }, { upsert: true });
        }
        await c.history.updateOne({ _id: p.deliveryId }, { $setOnInsert: {
          enterpriseId: config._id, revision: config.revision, shopId,
          window: state.window!, acceptedAt: new Date(p.acceptedAt), recordCount: p.recordCount,
        } }, { upsert: true });
        await save({
          after: p.after, entity: p.entity, lastSuccess: p.acceptedAt, attempts: 0,
          ...(p.final ? { completedWindow: state.window, baselineDone: true } : {}),
        }, { pending: "", failure: "", retryAt: "", ...(p.final ? { window: "", startedAt: "" } : {}) });
        return;
      }
      if (!state.window) {
        const date = dueDate(now, config.timeZone, config.dailyTime);
        if (!date || (state.completedWindow && date <= state.completedWindow)) return;
        Object.assign(state, { window: date, startedAt: now.toISOString(), entity: "work_order", after: "",
          coverage: { scanned: 0, missing: 0, oversized: 0, mode: "collecting" } });
        await save({ window: state.window, startedAt: state.startedAt, entity: state.entity,
          after: state.after, coverage: state.coverage });
      }
      const page = await deps.source(shopId, state.entity, state.after);
      const final = !page.ids.length && state.entity === "invoice";
      if (!page.ids.length && !final) {
        await save({ entity: "invoice", after: "" }); return;
      }
      const records: Snapshot[] = [], hashes: Pending["hashes"] = [];
      const coverage = { ...state.coverage, mode: final ? "collected" : "collecting" };
      let bytes = 0;
      const processed: string[] = [], seen = new Set<string>();
      // Bound each page's total payload. Oversized records are reported, not truncated.
      for (const candidateId of page.ids) {
        await save({ leaseUntil: new Date(deps.now().getTime() + 120_000) });
        const snapshot = page.snapshots.find(s => s.providerId === candidateId.toLowerCase());
        if (!snapshot) { processed.push(candidateId); coverage.scanned++; coverage.missing++; continue; }
        const key = `${snapshot.entityType}_${snapshot.providerId}`, hash = snapshotHash(snapshot);
        if (seen.has(key)) { processed.push(candidateId); coverage.scanned++; continue; }
        const prior = await c.hashes.findOne({ _id: `${id}_${key}` });
        if (prior?.hash === hash) { processed.push(candidateId); coverage.scanned++; continue; }
        const size = Buffer.byteLength(JSON.stringify(snapshot));
        if (size > MAX_BODY_BYTES - 8192) {
          processed.push(candidateId); coverage.scanned++; coverage.oversized++; continue;
        }
        if (!state.baselineDone && !config.initialSnapshot) {
          await c.hashes.updateOne({ _id: `${id}_${key}` }, { $set: { hash, updatedAt: now } }, { upsert: true });
          processed.push(candidateId); coverage.scanned++;
          continue;
        }
        // Stop BEFORE the record that will not fit. Advance only through the
        // records actually processed, leaving the rest for the next page.
        if (bytes + size > MAX_BODY_BYTES - 8192) {
          break;
        }
        processed.push(candidateId); coverage.scanned++; seen.add(key);
        bytes += size; records.push(snapshot); hashes.push({ key, hash });
      }
      const after = processed.at(-1) ?? state.after;
      state.coverage = coverage;
      if (!records.length && !final) {
        await save({ after, coverage, attempts: 0 }, { failure: "", retryAt: "" }); return;
      }
      const deliveryId = randomUUID();
      const body = envelope(config, state, records, final, deliveryId);
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("payload_too_large");
      await authorized();
      await save({ coverage, pending: { deliveryId, body, createdAt: now.toISOString(),
        hashes, after, entity: state.entity, final, recordCount: records.length }, attempts: 0 },
      { failure: "", retryAt: "" });
    } catch (error) {
      // Never persist underlying errors: they can contain URLs, queries or payloads.
      const code = error instanceof Error ? error.message : "";
      const safe = /^(authorization_paused_or_revoked|shop_ownership_changed|provider_not_protractor|protractor_disconnected|shop_not_active|shop_not_entitled|receiver_rate_limited|receiver_not_acknowledged|receiver_unavailable|receiver_timeout|destination_not_public|destination_dns_timeout|payload_too_large|lease_lost)$/.test(code)
        ? code : state.pending ? "delivery_or_checkpoint_unavailable" : "collection_unavailable";
      await save({ failure: safe, attempts: state.attempts + 1,
        retryAt: new Date(now.getTime() + Math.min(6 * 3600_000, 30_000 * 2 ** state.attempts)) });
    }
  } finally {
    await c.states.updateOne({ _id: id, lease }, { $unset: { lease: "", leaseUntil: "" } });
  }
}
