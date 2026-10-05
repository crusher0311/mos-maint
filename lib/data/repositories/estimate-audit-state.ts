import { getDb } from "@/lib/mongo";
import type { Db } from "mongodb";
import {
  AUDIT_AUTOMATION_COLLECTIONS,
  type AuditState,
} from "@/lib/estimate-assist/audit-automation";

export type AuditLease = { collection: string; key: string; token: string };
type ReceiptOrdering = Pick<AuditState, "upstreamUpdatedAt" | "upstreamRevision">;

export interface EstimateAuditStateRepository {
  findState(id: string): Promise<AuditState | null>;
  /**
   * CAS both the state revision and receipt watermark. A duplicate must never
   * move the provider ordering watermark backwards after a concurrent receipt.
   */
  touchReceipt(
    state: AuditState,
    at: Date,
    incoming: ReceiptOrdering,
  ): Promise<{ modifiedCount: number }>;
  reclaimRunning(id: string, revision: number, at: Date): Promise<{ modifiedCount: number }>;
  reviveFailed(id: string, revision: number, at: Date): Promise<{ modifiedCount: number }>;
  writeReceiptRevision(
    id: string,
    current: AuditState | null,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount: number; upsertedCount: number }>;
  findHistoryRepair(id: string, revision: number): Promise<AuditState | null>;
  isProviderRoutedForShop(shopId: number, provider: string): Promise<boolean>;
  claim(id: string, revision: number, token: string, leaseUntil: Date): Promise<AuditState | null>;
  update(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ modifiedCount: number }>;
  acquireLease(lease: AuditLease, leaseUntil: Date): Promise<boolean>;
  releaseLease(lease: AuditLease): Promise<void>;
  upsertHistory(state: AuditState, report: any, completedAt: Date): Promise<void>;
}

export async function getEstimateAuditStateRepository(): Promise<EstimateAuditStateRepository> {
  const db = await getDb();
  return createEstimateAuditStateRepository(db);
}

export function createEstimateAuditStateRepository(db: Db): EstimateAuditStateRepository {
  const states = db.collection<AuditState>(AUDIT_AUTOMATION_COLLECTIONS.states);
  const receiptWatermarkFilter = (state: AuditState) => ({
    _id: state._id,
    revision: state.revision,
    ...(state.upstreamUpdatedAt
      ? { upstreamUpdatedAt: state.upstreamUpdatedAt }
      : { upstreamUpdatedAt: { $exists: false } }),
    ...(state.upstreamRevision
      ? { upstreamRevision: state.upstreamRevision }
      : { upstreamRevision: { $exists: false } }),
  });

  return {
    findState: (id) => states.findOne({ _id: id }),
    async touchReceipt(state, at, incoming) {
      const set: Record<string, unknown> = { lastReceiptAt: at };
      const unset: Record<string, "" > = {};
      if (incoming.upstreamUpdatedAt) set.upstreamUpdatedAt = incoming.upstreamUpdatedAt;
      if (incoming.upstreamRevision) set.upstreamRevision = incoming.upstreamRevision;
      else if (incoming.upstreamUpdatedAt) unset.upstreamRevision = "";
      return states.updateOne(
        receiptWatermarkFilter(state),
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { maxTimeMS: 5_000 },
      );
    },
    reclaimRunning: (id, revision, at) => states.updateOne(
      { _id: id, revision, status: "running", runLeaseUntil: { $lte: at } },
      { $set: { status: "pending", updatedAt: at, lastError: "worker_lease_expired" }, $unset: { runToken: "", runLeaseUntil: "" } },
      { maxTimeMS: 5_000 },
    ),
    reviveFailed: (id, revision, at) => states.updateOne(
      { _id: id, revision, status: "failed" },
      { $set: { status: "pending", updatedAt: at, lastError: undefined } },
      { maxTimeMS: 5_000 },
    ),
    writeReceiptRevision: (id, current, update) => {
      const filter = current
        ? receiptWatermarkFilter(current)
        : { _id: id, revision: { $exists: false } };
      return states.updateOne(filter as any, update as any, {
        upsert: !current,
        maxTimeMS: 5_000,
      });
    },
    findHistoryRepair: (id, revision) => states.findOne({
      _id: id,
      revision,
      status: { $in: ["complete", "partial"] },
      historyPending: true,
    }),
    async isProviderRoutedForShop(shopId, provider) {
      const shop = await db.collection<any>("shops").findOne(
        { $or: [{ shopId }, { shopId: String(shopId) }] },
        {
          projection: {
            integrationProvider: 1,
            smsProvider: 1,
            provider: 1,
            integrations: 1,
            tekmetric: 1,
            protractor: 1,
            shopware: 1,
            shopmonkey: 1,
          },
          maxTimeMS: 5_000,
        },
      );
      if (!shop) return false;
      const normalized = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z]/g, "");
      const wanted = normalized(provider);
      const configured = [
        shop.integrationProvider,
        shop.smsProvider,
        shop.provider,
        ...Object.keys(shop.integrations || {}),
        ...["tekmetric", "protractor", "shopware", "shopmonkey"].filter((key) => shop[key]),
      ].map(normalized);
      return configured.includes(wanted);
    },
    async claim(id, revision, token, leaseUntil) {
      const now = new Date();
      const claim = await states.findOneAndUpdate(
        { _id: id, revision, $or: [{ status: "pending" }, { status: "running", runLeaseUntil: { $lte: now } }] },
        { $set: { status: "running", updatedAt: now, startedAt: now, runToken: token, runLeaseUntil: leaseUntil } },
        { returnDocument: "after", maxTimeMS: 5_000 },
      );
      return ((claim as any)?.value ?? claim) as AuditState | null;
    },
    async update(filter, update) {
      return states.updateOne(filter as any, update as any, { maxTimeMS: 5_000 });
    },
    async acquireLease(lease, leaseUntil) {
      const now = new Date();
      try {
        const result = await db.collection<any>(lease.collection).updateOne(
          { _id: lease.key, $or: [{ leaseUntil: { $lte: now } }, { token: lease.token }] },
          { $set: { token: lease.token, leaseUntil, updatedAt: now }, $setOnInsert: { createdAt: now } },
          { upsert: true, maxTimeMS: 5_000 },
        );
        return result.modifiedCount > 0 || result.upsertedCount > 0;
      } catch (error: any) {
        if (error?.code === 11000) return false;
        throw error;
      }
    },
    async releaseLease(lease) {
      await db.collection<any>(lease.collection).updateOne(
        { _id: lease.key, token: lease.token },
        { $set: { leaseUntil: new Date(0), releasedAt: new Date() }, $unset: { token: "" } },
        { maxTimeMS: 5_000 },
      );
    },
    async upsertHistory(state, report, completedAt) {
      await db.collection<any>(AUDIT_AUTOMATION_COLLECTIONS.history).updateOne(
        { _id: `${state._id}:${state.revision}` },
        {
          $setOnInsert: {
            _id: `${state._id}:${state.revision}`,
            shopId: state.shopId, provider: state.provider, workOrderId: state.workOrderId,
            workOrderNumber: state.workOrderNumber, revision: state.revision,
            lineItemCount: state.lineItemCount ?? 0, findingCount: report.findings.length,
            score: report.summary.score, report, automation: true, createdAt: completedAt,
          },
        },
        { upsert: true, maxTimeMS: 5_000 },
      );
    },
  };
}