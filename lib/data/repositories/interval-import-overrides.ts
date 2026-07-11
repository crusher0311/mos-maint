/**
 * Repository for `interval_import_service_key_overrides` — operator-managed
 * mappings from a maintenance-guide document service name to a canonical
 * shop-adjustable interval key (COMMON_SERVICES). When the built-in matcher
 * (`mapImportServiceNameToKey` in lib/interval-import.ts) doesn't recognize
 * a wording, a platform admin can assign it a key from the
 * /platform-admin/interval-import-match page; the override is consulted
 * live by the document-import route so the fix applies without a deploy.
 *
 * Mirrors the CARFAX override store (lib/carfax-overrides.ts), but lives in
 * the repository layer so app code doesn't call getDb() directly. Overrides
 * are keyed by the *normalized* name (lowercase, single-spaced) so casing /
 * spacing variants collapse onto one rule.
 */

import type { Db } from "mongodb";
import { getDb } from "@/lib/mongo";
import { normalizeIntervalImportName } from "@/lib/interval-import-log";
import { COMMON_SERVICE_KEYS } from "@/lib/interval-common-services";

const COLLECTION = "interval_import_service_key_overrides";

/** TTL for the in-process cache of the overrides map. */
const CACHE_TTL_MS = 30 * 1000;

export interface IntervalImportOverride {
  /** Normalized document service name (lowercase, single-spaced) — the match key. */
  normalizedName: string;
  /** Canonical COMMON_SERVICES key this name should resolve to. */
  serviceKey: string;
  /** Original name text, kept for display. */
  sampleName: string;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function isValidIntervalImportServiceKey(key: string): boolean {
  return COMMON_SERVICE_KEYS.has(key);
}

let cache: { at: number; map: Map<string, string> } | null = null;

/** Drop the in-process cache so the next read reflects a just-written change. */
export function invalidateIntervalImportOverridesCache(): void {
  cache = null;
}

async function collection(db?: Db) {
  const _db = db ?? (await getDb());
  return _db.collection<IntervalImportOverride>(COLLECTION);
}

/**
 * Map of normalizedName → serviceKey for the import matcher to consult.
 * Cached briefly in-process to avoid a Mongo round-trip on every import;
 * busted on any write in this process and otherwise expires by TTL (so a
 * write on another process is picked up within ~30s).
 */
export async function getIntervalImportOverridesMap(db?: Db): Promise<Map<string, string>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.map;

  const col = await collection(db);
  const docs = await col
    .find({}, { projection: { normalizedName: 1, serviceKey: 1 } })
    .toArray();

  const map = new Map<string, string>();
  for (const d of docs) {
    if (!d.normalizedName || !d.serviceKey) continue;
    if (!isValidIntervalImportServiceKey(d.serviceKey)) continue;
    map.set(d.normalizedName, d.serviceKey);
  }
  cache = { at: now, map };
  return map;
}

/** Full list of overrides for the admin UI, newest first. */
export async function listIntervalImportOverrides(db?: Db): Promise<IntervalImportOverride[]> {
  const col = await collection(db);
  const docs = await col.find({}).sort({ updatedAt: -1 }).toArray();
  return docs.map((d) => ({
    normalizedName: d.normalizedName,
    serviceKey: d.serviceKey,
    sampleName: d.sampleName,
    createdBy: d.createdBy ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }));
}

/**
 * Create or update an override. Returns the stored doc. Throws on an
 * invalid service key or blank name so callers can surface a 400.
 */
export async function upsertIntervalImportOverride(
  args: { name: string; serviceKey: string; createdBy?: string | null },
  db?: Db,
): Promise<IntervalImportOverride> {
  const normalizedName = normalizeIntervalImportName(args.name);
  if (!normalizedName) throw new Error("Service name is required");
  if (!isValidIntervalImportServiceKey(args.serviceKey)) {
    throw new Error(`Unknown interval service key: ${args.serviceKey}`);
  }

  const now = new Date().toISOString();
  const col = await collection(db);
  await col.updateOne(
    { normalizedName },
    {
      $set: {
        normalizedName,
        serviceKey: args.serviceKey,
        sampleName: String(args.name ?? "").trim(),
        createdBy: args.createdBy ?? null,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  invalidateIntervalImportOverridesCache();

  return {
    normalizedName,
    serviceKey: args.serviceKey,
    sampleName: String(args.name ?? "").trim(),
    createdBy: args.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Remove an override by name (raw or normalized). */
export async function deleteIntervalImportOverride(name: string, db?: Db): Promise<boolean> {
  const normalizedName = normalizeIntervalImportName(name);
  if (!normalizedName) return false;
  const col = await collection(db);
  const res = await col.deleteOne({ normalizedName });
  invalidateIntervalImportOverridesCache();
  return res.deletedCount > 0;
}
