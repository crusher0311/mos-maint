import { getDb } from "@/lib/data/db";
import {
  isTekmetricCachePgCanonical,
  shouldShadowWriteMongoTekmetricCache,
  shadowWriteMongoIntegrationCache,
} from "@/lib/db/integration-cache-write-mode";
import { evidenceTimestamp, type TekmetricDviRecord } from "@/lib/dvi-engagement";
import * as pg from "./pg/dvi-engagement";

export type DviEvidenceWrite = {
  inspectionSharedAt?: string;
  inspectionViewReceivedAt?: string;
};

/**
 * Atomic earliest-evidence merge. Duplicate/out-of-order events cannot erase a
 * positive, move its first recorded time later, or replace a provider snapshot.
 */
export async function recordTekmetricDviEvidence(
  shopId: number, roId: string, evidence: DviEvidenceWrite,
): Promise<void> {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || !/^[1-9]\d*$/.test(roId)) return;
  const fields: Record<string, string> = {};
  const sent = evidenceTimestamp(evidence.inspectionSharedAt);
  const viewed = evidenceTimestamp(evidence.inspectionViewReceivedAt);
  if (sent) fields.dviInspectionSharedAt = sent;
  if (viewed) fields.dviInspectionViewReceivedAt = viewed;
  if (!Object.keys(fields).length) return;
  const mongoWrite = async () => {
    const db = await getDb();
    await db.collection("tekmetric_work_orders").updateOne(
      { shopId: { $in: [shopId, String(shopId)] }, workOrderId: { $in: [roId, Number(roId)] } },
      { $min: fields, $setOnInsert: { shopId, workOrderId: roId } },
      { upsert: true },
    );
  };
  if (isTekmetricCachePgCanonical()) {
    await pg.recordTekmetricDviEvidence(shopId, roId, fields);
    await shadowWriteMongoIntegrationCache(
      shouldShadowWriteMongoTekmetricCache, "tekmetric.dvi.evidence", mongoWrite,
    );
  } else {
    await mongoWrite();
  }
}

/** One bounded query for at most the report's 300 selected provider RO ids. */
export async function findTekmetricDviEvidence(
  shopId: number, roIds: string[], budgetMs = 1_000,
): Promise<TekmetricDviRecord[]> {
  const ids = [...new Set(roIds.filter(id => /^[1-9]\d*$/.test(id)))].slice(0, 300);
  if (!ids.length || budgetMs <= 0) return [];
  if (isTekmetricCachePgCanonical()) return pg.findTekmetricDviEvidence(shopId, ids, budgetMs);
  const db = await getDb();
  const docs = await db.collection("tekmetric_work_orders").find({
    shopId: { $in: [shopId, String(shopId)] },
    workOrderId: { $in: [...ids, ...ids.map(Number)] },
  }, { projection: {
    workOrderId: 1, dviInspectionSharedAt: 1, dviInspectionViewReceivedAt: 1,
    "data.inspectionShareDate": 1,
  } }).limit(600).maxTimeMS(Math.max(1, Math.floor(budgetMs))).toArray();
  return docs.map(doc => ({
    workOrderId: String(doc.workOrderId),
    dviInspectionSharedAt: doc.dviInspectionSharedAt,
    dviInspectionViewReceivedAt: doc.dviInspectionViewReceivedAt,
    inspectionShareDate: doc.data?.inspectionShareDate,
  }));
}
