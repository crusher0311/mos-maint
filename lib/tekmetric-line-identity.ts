import { and, eq, sql } from 'drizzle-orm';
import { normalizedLineItems, normalizedServiceJobs } from './db/schema/normalized';

export type TekmetricLineScope = { shopId: number; workOrderId: string; serviceJobId: string; lineType: string };
export function lineAliases(value: unknown, type: string): string[] {
  if (!['part', 'labor'].includes(type)) throw new Error('Unsupported Tekmetric line identity');
  const id = String(value ?? '');
  const raw = id.startsWith(`${type}-`) ? id.slice(type.length + 1) : id;
  if (!raw || /^(part|labor)-/.test(raw)) throw new Error('Invalid Tekmetric line identity');
  return [raw, `${type}-${raw}`];
}
function validateOwner(row: any, aliases: string[]) {
  const p = row.provenance;
  if ((p?.sourceSystem && p.sourceSystem !== 'tekmetric' && p.sourceSystem !== 'unknown') ||
      !Array.isArray(p?.sourceIds) || !p.sourceIds.length ||
      p.sourceIds.some((s: any) => s.system !== 'tekmetric' || s.idType !== 'line_item_id' || !aliases.includes(String(s.idValue)))) {
    throw new Error('Tekmetric line ownership conflict');
  }
}
export async function findTekmetricLine(db: any, scope: TekmetricLineScope, sourceId: unknown, lock = false) {
  const aliases = lineAliases(sourceId, scope.lineType);
  const query = db.select().from(normalizedLineItems).where(and(
    eq(normalizedLineItems.shopId, scope.shopId), eq(normalizedLineItems.workOrderId, scope.workOrderId),
    eq(normalizedLineItems.serviceJobId, scope.serviceJobId), eq(normalizedLineItems.lineType, scope.lineType as any),
    sql`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${normalizedLineItems.provenance}->'sourceIds')='array' THEN ${normalizedLineItems.provenance}->'sourceIds' ELSE '[]'::jsonb END) s WHERE s->>'idValue' IN (${aliases[0]}, ${aliases[1]}))`,
  )).limit(2);
  const rows = await (lock ? query.for('update') : query);
  if (rows.length > 1) throw new Error('Ambiguous existing Tekmetric lines; review required');
  if (!rows.length) return null;
  validateOwner(rows[0], aliases);
  return { ...rows[0], _id: rows[0].id, __fromPg: true };
}
export async function writeTekmetricLine(db: any, doc: any, write: (tx: any, doc: any, existing: boolean) => Promise<string>) {
  const shopId = Number(doc.shopId);
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || typeof doc.workOrderId !== 'string' || !doc.workOrderId || typeof doc.serviceJobId !== 'string' || !doc.serviceJobId) {
    throw new Error('Invalid Tekmetric line scope');
  }
  doc = { ...doc, shopId };
  const sourceId = doc.provenance?.sourceIds?.[0]?.idValue;
  const aliases = lineAliases(sourceId, doc.lineType);
  validateOwner(doc, aliases);
  return db.transaction(async (tx: any) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    // All updated writers serialize the lookup AND insert, including legacy IDs.
    const key = JSON.stringify(['tekmetric-line', doc.shopId, doc.serviceJobId, doc.lineType, aliases[0]]);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const parent = await tx.select({ id: normalizedServiceJobs.id }).from(normalizedServiceJobs).where(and(
      eq(normalizedServiceJobs.id, doc.serviceJobId), eq(normalizedServiceJobs.shopId, doc.shopId),
      eq(normalizedServiceJobs.workOrderId, doc.workOrderId),
    )).limit(1);
    if (!parent.length) throw new Error('Tekmetric line parent scope conflict');
    const existing = await findTekmetricLine(tx, doc, sourceId, true);
    const id = existing?._id ?? doc._id;
    const collision = await tx.select({ id: normalizedLineItems.id }).from(normalizedLineItems)
      .where(eq(normalizedLineItems.id, id)).limit(1);
    if (collision.length && !existing) throw new Error('Tekmetric line ID ownership conflict');
    return write(tx, { ...doc, _id: id, ...(existing ? { createdAt: existing.createdAt, version: existing.version + 1 } : {}) }, !!existing);
  });
}
