// Read-only source for a Tekmetric vehicle's previously declined/deferred
// jobs, surfaced in the extension so techs can see work a customer turned
// down.
//
// Tekmetric declined/deferred jobs are already ingested during sync: a job
// with `authorized === false` is stamped onto its `job_index` row (see
// lib/integrations/tekmetric/job-index.ts). This repository reads those rows
// by VIN and shapes them to match the per-item contract the extension's
// deferred renderer already understands (title, date, lines).
import type { Collection, Document, Filter } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "job_index";

interface JobIndexLine {
  lineType?: string;
  description?: string;
  partNumber?: string;
  manufacturer?: string;
  quantity?: number;
  unitPrice?: number;
  hours?: number;
  // Task #809 — real per-unit part cost (dollars) captured at index time.
  cost?: number;
  extendedCost?: number;
}

interface TekmetricJobIndexRow extends Document {
  shopId: number;
  authorized?: boolean;
  workOrderNumber?: number;
  servicePackageId?: string;
  performedAt?: Date;
  job?: { title?: string; description?: string };
  vehicle?: { vin?: string };
  lines?: JobIndexLine[];
  metadata?: { sourceType?: string };
}

export interface TekmetricDeferredWorkItem {
  id: string;
  title: string;
  description: string;
  code: string;
  originalWorkOrderNumber: number | null;
  date: string | null;
  chapter: string;
  lines: Array<{
    description: string;
    lineType: string;
    quantity: number;
    unitPrice: number;
    partNumber: string;
    manufacturer: string;
    /** Task #809 — real per-unit part cost (dollars), when the source knows it. */
    cost?: number;
    extendedCost?: number;
  }>;
}

async function collection(): Promise<Collection<TekmetricJobIndexRow>> {
  const db = await getDb();
  return db.collection<TekmetricJobIndexRow>(COLLECTION);
}

/**
 * Returns a Tekmetric vehicle's declined/deferred jobs (customer turned them
 * down: `authorized === false`) for a shop, most-recent first.
 *
 * VIN casing can vary across legacy writers, so we match both the upper-cased
 * and raw forms. The query is bounded by `shopId` + `limit` and sorted by
 * `performedAt` (backed by the {shopId, performedAt} index) — the same access
 * pattern the Protractor pricing fallback uses on this collection.
 */
export async function listTekmetricDeferredWorkByVin(
  shopId: number,
  vin: string,
  limit = 50,
): Promise<TekmetricDeferredWorkItem[]> {
  const normVin = vin.toUpperCase();
  const vinValues = normVin === vin ? [normVin] : [normVin, vin];

  const col = await collection();
  const rows = await col
    .find({
      shopId,
      "vehicle.vin": { $in: vinValues },
      authorized: false,
      "metadata.sourceType": "tekmetric",
    } as Filter<TekmetricJobIndexRow>)
    .sort({ performedAt: -1 })
    .limit(limit)
    .toArray();

  return rows.map((row) => {
    const lines = Array.isArray(row.lines) ? row.lines : [];
    return {
      id: String(row.servicePackageId ?? row._id ?? ""),
      title: row.job?.title || "Declined job",
      description: row.job?.description || "",
      code: "",
      originalWorkOrderNumber: row.workOrderNumber ?? null,
      date: row.performedAt ? new Date(row.performedAt).toISOString() : null,
      chapter: "Service",
      lines: lines.map((l) => ({
        description: l.description || "",
        lineType: l.lineType || "labor",
        quantity: l.quantity ?? 1,
        unitPrice: l.unitPrice ?? 0,
        partNumber: l.partNumber || "",
        manufacturer: l.manufacturer || "",
        // Task #809 — surface the real part cost so the extension can push
        // it back to the RO instead of estimating from retail.
        ...(typeof l.cost === "number" && l.cost > 0 ? { cost: l.cost } : {}),
        ...(typeof l.extendedCost === "number" && l.extendedCost > 0
          ? { extendedCost: l.extendedCost }
          : {}),
      })),
    };
  });
}
