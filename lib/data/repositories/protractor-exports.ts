import { getDb } from "@/lib/data/db";
import type { Db, IndexDescriptionInfo } from "mongodb";
import { type ExportConfig, type Entity } from "@/lib/protractor-exports/contract";
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
// Keep in sync with docs/runbooks/protractor-export-production-setup.md.
const exportIndexes = [
  { collection: "protractor_export_configs", name: "export_active", key: { paused: 1, revoked: 1, _id: 1 } },
  { collection: "protractor_export_states", name: "export_status", key: { enterpriseId: 1, revision: 1, shopId: 1 } },
  { collection: "protractor_export_states", name: "export_retention", key: { "pending.createdAt": 1 } },
  { collection: "protractor_export_history", name: "export_history_ttl", key: { acceptedAt: 1 }, ttl: 7776000 },
  { collection: "protractor_export_history", name: "export_history_enterprise_accepted", key: { enterpriseId: 1, acceptedAt: -1 } },
] as const;
const sourceIndexes = [
  { collection: "protractor_work_orders", key: { shopId: 1, workOrderId: 1 } },
  { collection: "protractor_invoices", key: { shopId: 1, invoiceId: 1 } },
  { collection: "protractor_invoice_cache", key: { shopId: 1, invoiceId: 1 } },
] as const;

function simpleCollation(collation: { locale?: string } | undefined) {
  return collation === undefined || collation.locale === "simple";
}
function compatibleIndex(index: IndexDescriptionInfo, key: object, ttl?: number) {
  const actual = Object.entries(index.key), expected = Object.entries(key);
  return actual.length === expected.length &&
    actual.every(([field, direction], i) => field === expected[i][0] && direction === expected[i][1]) &&
    index.expireAfterSeconds === ttl && !index.hidden && !index.sparse &&
    index.partialFilterExpression === undefined && simpleCollation(index.collation);
}

/** Read-only preflight: never repair indexes from a worker. Mongo sources remain
 * required in PG canonical mode because the exporter reads both stores. */
export async function prerequisites(database?: Pick<Db, "collection" | "listCollections">) {
  const db = database ?? await getDb();
  for (const collection of new Set([...exportIndexes, ...sourceIndexes].map(spec => spec.collection))) {
    const fail = (requirement: string): never => {
      throw new Error(`Export indexes require operator setup: ${collection} ${requirement}`);
    };
    // sourcePage uses the collection default and merges cursors with JS binary
    // ordering. Even an explicitly simple index cannot fix a non-simple query.
    const metadata = await db.listCollections({ name: collection }, { nameOnly: false }).toArray();
    if (metadata.length !== 1 || metadata[0].type !== "collection")
      fail("collection missing or unsupported");
    if (!simpleCollation(metadata[0].options?.collation))
      fail("requires simple default collation");
    const indexes = await db.collection(collection).listIndexes().toArray();
    for (const spec of exportIndexes.filter(spec => spec.collection === collection)) {
      const index = indexes.find(index => index.name === spec.name);
      if (!index || index.unique || !compatibleIndex(index, spec.key, "ttl" in spec ? spec.ttl : undefined))
        fail(`${spec.name} missing or incompatible`);
    }
    for (const spec of sourceIndexes.filter(spec => spec.collection === collection)) {
      // Existing source index names (and uniqueness) are operator-owned.
      if (!indexes.some(index => compatibleIndex(index, spec.key)))
        fail("source cursor index missing or incompatible");
    }
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
