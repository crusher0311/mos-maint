import { sql } from "drizzle-orm";
import { getDb as mongo } from "@/lib/data/db";
import { getDb as postgres } from "@/lib/db/drizzle";
import { isProtractorCachePgCanonical } from "@/lib/db/integration-cache-write-mode";
import { PAGE_SIZE, type Entity, type Snapshot } from "./contract";

export interface Candidate { id: string; at: unknown; raw: unknown; source: string }
const forbidden = /^(?:_.*|apiKey|accessToken|refreshToken|password|secret|authorization|credentials)$/i;
// Includes nested ServicePackages.InspectionLines and SOAP
// ServicePackageInspectionLines; future inspection fields fail closed too.
const dvi = /inspection|dvi/i;
/** Preserve provider fields, excluding DVI subdocuments. Never export cache wrappers. */
export function providerPayload(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  function visit(value: any, depth: number): any {
    if (depth > 40) throw new Error("invalid_payload");
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(v => visit(v, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [k,v] of Object.entries(value)) {
      if (forbidden.test(k)) throw new Error("unsafe_payload");
      if (!dvi.test(k)) result[k] = visit(v, depth + 1);
    }
    return result;
  }
  try { return visit(raw, 0); } catch { return null; }
}
export function selectSnapshot(shopId: number, entityType: Entity, id: string, candidates: Candidate[]): Snapshot | null {
  const valid = candidates.filter(c => c.id.toLowerCase() === id.toLowerCase())
    .map(c => ({ ...c, time: new Date(c.at as any).getTime(), payload: providerPayload(c.raw) }))
    .filter(c => Number.isFinite(c.time))
    .sort((a,b) => b.time - a.time || a.source.localeCompare(b.source));
  const best = valid[0];
  return best?.payload && typeof best.payload.ID === "string" &&
    best.payload.ID.toLowerCase() === id.toLowerCase() ? { shopId, entityType, providerId: id.toLowerCase(),
    observedAt: new Date(best.time).toISOString(), source: best.source, payload: best.payload! } : null;
}
const tables = (entity: Entity) => entity === "work_order"
  ? ["protractor_work_orders"] : ["protractor_invoices", "protractor_invoice_cache"];

/** Local keyset sweep, never upstream and never filtered by invoice date.
 * Read both stores when PG is canonical: active client writers still use Mongo.
 * A failed source aborts the page; it cannot be mistaken for an empty window. */
export async function sourcePage(shopId: number, entity: Entity, after: string) {
  const db = await mongo(), pg = isProtractorCachePgCanonical();
  const key = entity === "work_order" ? "workOrderId" : "invoiceId";
  const column = entity === "work_order" ? "work_order_id" : "invoice_id";
  const ids = new Set<string>();
  for (const table of tables(entity)) {
    const docs = await db.collection(table).find({
      shopId: { $in: [shopId, String(shopId)] }, [key]: { $gt: after },
    }, { projection: { [key]: 1 }, maxTimeMS: 2500 }).sort({ [key]: 1 }).limit(PAGE_SIZE).toArray();
    for (const doc of docs) if (typeof doc[key] === "string") ids.add(doc[key]);
    if (pg) {
      const rows = await postgres().transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
        return tx.execute(sql`SELECT ${sql.identifier(column)} AS id FROM ${sql.identifier(table)}
          WHERE shop_id = ${shopId} AND ${sql.identifier(column)} COLLATE "C" > ${after}
          ORDER BY ${sql.identifier(column)} COLLATE "C" LIMIT ${PAGE_SIZE}`);
      });
      for (const row of rows as any[]) ids.add(row.id);
    }
  }
  const selected = [...ids].sort().slice(0, PAGE_SIZE);
  if (!selected.length) return { ids: [], snapshots: [], missing: 0 };
  const variants = [...new Set(selected.flatMap(id => [id, id.toLowerCase(), id.toUpperCase()]))];
  const candidates: Candidate[] = [];
  for (const table of tables(entity)) {
    const cache = table === "protractor_invoice_cache";
    const docs = await db.collection(table).find({
      shopId: { $in: [shopId, String(shopId)] }, [key]: { $in: variants },
    }, { projection: { [key]: 1, rawPayload: 1, data: 1, invoice: 1, fetchedAt: 1, cachedAt: 1 },
      maxTimeMS: 2500 }).limit(PAGE_SIZE * 6).toArray();
    for (const d of docs) candidates.push({ id: d[key], at: cache ? d.cachedAt : d.fetchedAt,
      raw: cache ? d.invoice : d.rawPayload ?? d.data, source: `mongo.${table}` });
    if (pg) {
      const rows = await postgres().transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2500ms'`);
        return tx.execute(sql`SELECT ${sql.identifier(column)} AS id, payload,
          ${sql.identifier(cache ? "cached_at" : "fetched_at")} AS observed
          FROM ${sql.identifier(table)} WHERE shop_id = ${shopId}
          AND ${sql.identifier(column)} IN (${sql.join(variants.map(id => sql`${id}`), sql`, `)})`);
      });
      for (const r of rows as any[]) candidates.push({ id: r.id, at: r.observed,
        raw: cache ? r.payload?.invoice : r.payload?.rawPayload ?? r.payload?.data,
        source: `pg.${table}` });
    }
  }
  const snapshots = selected.map(id => selectSnapshot(shopId, entity, id, candidates));
  return { ids: selected, snapshots: snapshots.filter((s): s is Snapshot => !!s),
    missing: snapshots.filter(s => !s).length };
}
