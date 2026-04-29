/**
 * Task #187: Audit log for engine-risk-override CSV imports.
 *
 * The CSV import endpoint (`/api/platform-admin/engine-risk-overrides/import`)
 * already stamps `createdBy` / `updatedBy` on each affected override row,
 * but that gives no way to answer "which import did what?" when two
 * platform admins both bulk-edit in the same week. This module owns a
 * separate audit collection that captures one summary doc per successful
 * apply: who triggered it, when, the original file name, the row counts,
 * and the original CSV blob (so a rollback can be reconstructed by
 * re-uploading the prior file).
 *
 * Pure-ish helpers — they only talk to Mongo via the shared `Db` handle
 * so the route layer stays thin and so smoke tests can stub the
 * collection in-memory if needed.
 */
import { ObjectId, type Db } from "mongodb";

export const ENGINE_RISK_OVERRIDE_IMPORTS_COLLECTION =
  "engine_risk_override_imports";

export interface EngineRiskOverrideImportCounts {
  inserted: number;
  updated: number;
  removed: number;
  unchanged: number;
}

export interface EngineRiskOverrideImportEntry {
  _id?: ObjectId;
  adminEmail: string | null;
  fileName: string | null;
  /** UTF-8 byte length of the original CSV blob, for cheap display. */
  csvByteSize: number;
  csv: string;
  counts: EngineRiskOverrideImportCounts;
  createdAt: Date;
}

export interface RecordEngineRiskOverrideImportInput {
  adminEmail: string | null;
  fileName: string | null;
  csv: string;
  counts: EngineRiskOverrideImportCounts;
}

/** Insert one audit doc. Never throws — failure is logged so the
 * underlying CSV apply (which has already mutated the overrides
 * collection) is not rolled back by an audit-write hiccup. */
export async function recordEngineRiskOverrideImport(
  db: Db,
  input: RecordEngineRiskOverrideImportInput,
): Promise<ObjectId | null> {
  try {
    const csv = typeof input.csv === "string" ? input.csv : "";
    const fileName = sanitizeFileName(input.fileName);
    const doc: EngineRiskOverrideImportEntry = {
      adminEmail: input.adminEmail ?? null,
      fileName,
      csvByteSize: Buffer.byteLength(csv, "utf8"),
      csv,
      counts: {
        inserted: input.counts.inserted | 0,
        updated: input.counts.updated | 0,
        removed: input.counts.removed | 0,
        unchanged: input.counts.unchanged | 0,
      },
      createdAt: new Date(),
    };
    const res = await db
      .collection<EngineRiskOverrideImportEntry>(
        ENGINE_RISK_OVERRIDE_IMPORTS_COLLECTION,
      )
      .insertOne(doc);
    return res.insertedId ?? null;
  } catch (err) {
    console.error(
      "[engine-risk-import-audit] failed to record import:",
      err,
    );
    return null;
  }
}

export interface EngineRiskOverrideImportSummary {
  _id: string;
  adminEmail: string | null;
  fileName: string | null;
  csvByteSize: number;
  counts: EngineRiskOverrideImportCounts;
  createdAt: string;
}

/** Most-recent-first list of import audit docs. The CSV blob itself is
 * intentionally omitted so the listing endpoint stays small even if a
 * shop runs hundreds of historical imports; the blob is fetched on
 * demand by the per-import download route. */
export async function listRecentEngineRiskOverrideImports(
  db: Db,
  limit = 20,
): Promise<EngineRiskOverrideImportSummary[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit) || 20));
  const docs = await db
    .collection<EngineRiskOverrideImportEntry>(
      ENGINE_RISK_OVERRIDE_IMPORTS_COLLECTION,
    )
    .find({}, { projection: { csv: 0 } })
    .sort({ createdAt: -1 })
    .limit(safeLimit)
    .toArray();
  return docs.map((d) => ({
    _id: String(d._id),
    adminEmail: d.adminEmail ?? null,
    fileName: d.fileName ?? null,
    csvByteSize: typeof d.csvByteSize === "number" ? d.csvByteSize : 0,
    counts: {
      inserted: d.counts?.inserted ?? 0,
      updated: d.counts?.updated ?? 0,
      removed: d.counts?.removed ?? 0,
      unchanged: d.counts?.unchanged ?? 0,
    },
    createdAt: normaliseCreatedAt(d.createdAt),
  }));
}

/** Coerce whatever Mongo handed us (a Date, an ISO string left over
 * from an older insert path, a number of ms, or junk) into an ISO
 * string. We never throw — a malformed `createdAt` on one historical
 * doc must not blow up the entire imports list response, so any value
 * we can't make sense of falls back to the empty string. */
function normaliseCreatedAt(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  }
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  return "";
}

/** Fetch a single import doc by id — used by the CSV download route. */
export async function getEngineRiskOverrideImport(
  db: Db,
  id: string,
): Promise<EngineRiskOverrideImportEntry | null> {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) return null;
  const doc = await db
    .collection<EngineRiskOverrideImportEntry>(
      ENGINE_RISK_OVERRIDE_IMPORTS_COLLECTION,
    )
    .findOne({ _id: new ObjectId(id) });
  return doc ?? null;
}

/** File names come from a browser file picker so they may contain odd
 * characters. We strip path separators and control codes and clamp the
 * length so a hand-crafted name can't break the Content-Disposition
 * header on the download route. */
function sanitizeFileName(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const stripped = trimmed
    .replace(/[\\/]+/g, "_")
    .replace(/[\x00-\x1f\x7f"]/g, "")
    .slice(0, 200);
  return stripped || null;
}
