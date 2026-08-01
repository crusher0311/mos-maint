/**
 * Postgres-backed Protractor template cache — the read & write surface
 * used by `lib/data/repositories/protractor-template-cache.ts` when
 * `PROTRACTOR_OPS_PG_CANONICAL=1` (task #999).
 *
 * Backs the `protractor_template_cache` mirror table
 * (lib/db/schema/wave3.ts, PK (shopId, templateId)). The Mongo doc is
 * keyed by a synthetic `cacheKey` string that already embeds shopId +
 * templateId + a per-caller prefix ("protractor_template_" vs
 * "protractor_template_get_"), so two callers can cache the same
 * shopId/templateId under distinct keys. To preserve that namespacing on
 * the (shopId, templateId) PK we store the full `cacheKey` in the
 * `templateId` column and stash the verbatim Mongo doc (template, is404,
 * fetchedAt, expiresAt) in the `payload` jsonb.
 *
 * The dispatcher (PG-vs-Mongo) lives in the Mongo repo next to the call
 * site — this file has no knowledge of the kill-switch flag.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import { protractorTemplateCache } from "@/lib/db/schema/wave3";
import type {
  ProtractorTemplateCacheDoc,
  TemplateCacheShopStats,
} from "../protractor-template-cache";

export async function findFreshTemplateCacheEntry(
  cacheKey: string,
): Promise<ProtractorTemplateCacheDoc | null> {
  const db = getDb();
  const now = new Date();
  const rows = await db
    .select()
    .from(protractorTemplateCache)
    .where(eq(protractorTemplateCache.templateId, cacheKey))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const payload = (row.payload ?? {}) as ProtractorTemplateCacheDoc;
  // Enforce the Mongo `expiresAt: { $gt: now }` freshness filter.
  const expiresAt = payload.expiresAt
    ? new Date(payload.expiresAt as unknown as string)
    : null;
  if (!expiresAt || expiresAt.getTime() <= now.getTime()) return null;
  return { ...payload };
}

export async function upsertTemplateCacheEntry(
  entry: ProtractorTemplateCacheDoc,
): Promise<void> {
  const db = getDb();
  await db
    .insert(protractorTemplateCache)
    .values({
      shopId: entry.shopId,
      templateId: entry.cacheKey,
      payload: entry,
    })
    .onConflictDoUpdate({
      target: [
        protractorTemplateCache.shopId,
        protractorTemplateCache.templateId,
      ],
      set: { payload: entry, cachedAt: new Date() },
    });
}

export async function clearTemplateCache(opts: {
  shopId?: number | null;
  clear404sOnly?: boolean;
}): Promise<number> {
  const db = getDb();
  const conds = [];
  if (opts.shopId != null) {
    conds.push(eq(protractorTemplateCache.shopId, opts.shopId));
  }
  if (opts.clear404sOnly) {
    conds.push(
      sql`(${protractorTemplateCache.payload} ->> 'is404')::boolean IS TRUE`,
    );
  }
  const where = conds.length ? and(...conds) : undefined;
  const deleted = await db
    .delete(protractorTemplateCache)
    .where(where)
    .returning({ id: protractorTemplateCache.templateId });
  return deleted.length;
}

export async function templateCacheStats(): Promise<TemplateCacheShopStats[]> {
  const db = getDb();
  const rows = await db
    .select({
      shopId: protractorTemplateCache.shopId,
      total: sql<number>`count(*)::int`,
      cached: sql<number>`count(*) FILTER (WHERE (${protractorTemplateCache.payload} ->> 'is404')::boolean IS NOT TRUE)::int`,
      notFound: sql<number>`count(*) FILTER (WHERE (${protractorTemplateCache.payload} ->> 'is404')::boolean IS TRUE)::int`,
    })
    .from(protractorTemplateCache)
    .groupBy(protractorTemplateCache.shopId)
    .orderBy(sql`count(*) DESC`);
  return rows.map((r) => ({
    shopId: r.shopId,
    total: Number(r.total),
    cached: Number(r.cached),
    notFound: Number(r.notFound),
  }));
}
