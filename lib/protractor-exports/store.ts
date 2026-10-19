import { getDb } from "@/lib/data/db";
import { type ExportConfig, type Entity } from "./contract";
import { isIdentityPgCanonical } from "@/lib/db/wave4-write-mode";
import { findEnterpriseById as pgEnterprise } from "@/lib/data/repositories/pg/identity";
import { findEnterpriseById as mongoEnterprise } from "@/lib/data/repositories/enterprise";

export interface Pending {
  deliveryId: string; body: string; createdAt: string; acceptedAt?: string;
  hashes: Array<{ key: string; hash: string }>;
  after: string; entity: Entity; final: boolean; recordCount: number;
}
export interface ExportState {
  _id: string; enterpriseId: string; revision: number; shopId: number;
  window?: string; startedAt?: string; completedWindow?: string;
  entity: Entity; after: string; baselineDone: boolean;
  coverage: { scanned: number; missing: number; oversized: number; mode: string };
  pending?: Pending; lastSuccess?: string; failure?: string;
  attempts: number; retryAt?: Date; lease?: string; leaseUntil?: Date;
}
export async function collections() {
  const db = await getDb();
  const durable = { writeConcern: { w: "majority" as const, wtimeoutMS: 5000 },
    readConcern: { level: "majority" as const }, timeoutMS: 8000 };
  return {
    configs: db.collection<ExportConfig>("protractor_export_configs", durable),
    states: db.collection<ExportState>("protractor_export_states", durable),
    hashes: db.collection<{ _id: string; hash: string; updatedAt: Date }>("protractor_export_hashes", durable),
    history: db.collection<{ _id: string; enterpriseId: string; revision: number; shopId: number;
      window: string; acceptedAt: Date; recordCount: number }>("protractor_export_history", durable),
    health: db.collection<{ _id: string; seenAt: Date }>("protractor_export_health"),
  };
}
export const stateId = (c: ExportConfig, shopId: number) => `${c._id}_${c.revision}_${shopId}`;
export async function getConfig(id: string) { return (await collections()).configs.findOne({ _id: id }); }
export async function exportEnterprise(id: string) {
  return isIdentityPgCanonical() ? pgEnterprise(id) : mongoEnterprise(id);
}
export async function workerAvailable() {
  const row = await (await collections()).health.findOne({ _id: "worker" });
  return !!row && row.seenAt.getTime() > Date.now() - 90_000;
}
export async function prerequisites() {
  const c = await collections();
  for (const [collection, name] of [
    [c.configs, "export_active"], [c.history, "export_history_ttl"],
    [c.states, "export_status"], [c.states, "export_retention"],
  ] as const) {
    if (!(await collection.indexExists(name))) throw new Error("Export indexes require operator setup");
  }
}

/** Runs on the worker even for paused/revoked configurations. Retention expiry
 * blocks the checkpoint: it never masquerades as a delivered batch. */
export async function maintainExportRetention() {
  const c = await collections();
  const rows = await c.states.find({ "pending.createdAt": { $lt: new Date(Date.now() - 30 * 86400_000).toISOString() } },
    { projection: { enterpriseId: 1, revision: 1, "pending.acceptedAt": 1 } }).limit(100).toArray();
  for (const row of rows) {
    if (row.pending?.acceptedAt) {
      await c.states.updateOne({ _id: row._id, lease: { $exists: false } }, { $set: { "pending.body": "" } });
    } else {
      await c.states.updateOne({ _id: row._id, lease: { $exists: false } },
        { $unset: { pending: "" }, $set: { failure: "payload_retention_expired", attempts: 8 } });
    }
  }
}
