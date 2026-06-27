/**
 * Task #655 (manual edit): operator-managed overrides that map a CARFAX
 * service description to a canonical service key. When the built-in keyword
 * dictionary (`toKeyFromName` / `toKeyFromFreeText` in lib/service-keys.ts)
 * doesn't recognize a wording, a platform admin can assign it a key from the
 * CARFAX Match page. The override is stored in Mongo and consulted live by
 * the VHI matcher (triage) and the diagnostic, so the fix applies without a
 * code deploy.
 *
 * Overrides are keyed by the *normalized* description (lowercase, single-
 * spaced) so casing / spacing variants collapse onto one rule. One canonical
 * service key per description.
 */

import type { Db } from "mongodb";
import { SERVICE_KEYS } from "@/lib/service-keys";
import { normalizeCarfaxDescription } from "@/lib/carfax-match-log";

const COLLECTION = "carfax_service_key_overrides";

/** TTL for the in-process cache of the overrides map. */
const CACHE_TTL_MS = 30 * 1000;

export interface CarfaxOverride {
  /** Normalized description (lowercase, single-spaced) — the match key. */
  normalizedDescription: string;
  /** Canonical service key this description should resolve to. */
  serviceKey: string;
  /** Original description text, kept for display. */
  sampleDescription: string;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The set of canonical service keys an override may target. */
export function validServiceKeys(): string[] {
  return Object.keys(SERVICE_KEYS).sort();
}

export function isValidServiceKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(SERVICE_KEYS, key);
}

let cache: { at: number; map: Map<string, string[]> } | null = null;

/** Drop the in-process cache so the next read reflects a just-written change. */
export function invalidateCarfaxOverridesCache(): void {
  cache = null;
}

/**
 * Map of normalizedDescription → [serviceKey] for the matcher to consult.
 * Cached briefly in-process to avoid a Mongo round-trip on every plan build;
 * the cache is busted on any write in this process and otherwise expires by
 * TTL (so a write on another process is picked up within ~30s).
 */
export async function getCarfaxOverridesMap(db: Db): Promise<Map<string, string[]>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.map;

  const docs = await db
    .collection<CarfaxOverride>(COLLECTION)
    .find({}, { projection: { normalizedDescription: 1, serviceKey: 1 } })
    .toArray();

  const map = new Map<string, string[]>();
  for (const d of docs) {
    if (!d.normalizedDescription || !d.serviceKey) continue;
    if (!isValidServiceKey(d.serviceKey)) continue;
    map.set(d.normalizedDescription, [d.serviceKey]);
  }
  cache = { at: now, map };
  return map;
}

/** Full list of overrides for the admin UI, newest first. */
export async function listCarfaxOverrides(db: Db): Promise<CarfaxOverride[]> {
  const docs = await db
    .collection<CarfaxOverride>(COLLECTION)
    .find({})
    .sort({ updatedAt: -1 })
    .toArray();
  return docs.map((d) => ({
    normalizedDescription: d.normalizedDescription,
    serviceKey: d.serviceKey,
    sampleDescription: d.sampleDescription,
    createdBy: d.createdBy ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }));
}

/**
 * Create or update an override. Returns the stored doc. Throws on an invalid
 * service key or blank description so callers can surface a 400.
 */
export async function upsertCarfaxOverride(
  db: Db,
  args: { description: string; serviceKey: string; createdBy?: string | null },
): Promise<CarfaxOverride> {
  const normalizedDescription = normalizeCarfaxDescription(args.description);
  if (!normalizedDescription) throw new Error("Description is required");
  if (!isValidServiceKey(args.serviceKey)) {
    throw new Error(`Unknown service key: ${args.serviceKey}`);
  }

  const now = new Date().toISOString();
  await db.collection<CarfaxOverride>(COLLECTION).updateOne(
    { normalizedDescription },
    {
      $set: {
        normalizedDescription,
        serviceKey: args.serviceKey,
        sampleDescription: String(args.description ?? "").trim(),
        createdBy: args.createdBy ?? null,
        updatedAt: now,
      },
      $setOnInsert: { createdAt: now },
    },
    { upsert: true },
  );
  invalidateCarfaxOverridesCache();

  return {
    normalizedDescription,
    serviceKey: args.serviceKey,
    sampleDescription: String(args.description ?? "").trim(),
    createdBy: args.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Remove an override by description (raw or normalized). */
export async function deleteCarfaxOverride(db: Db, description: string): Promise<boolean> {
  const normalizedDescription = normalizeCarfaxDescription(description);
  if (!normalizedDescription) return false;
  const res = await db
    .collection<CarfaxOverride>(COLLECTION)
    .deleteOne({ normalizedDescription });
  invalidateCarfaxOverridesCache();
  return res.deletedCount > 0;
}
