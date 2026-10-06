import { findCachedWorkOrdersByIds } from "./data/repositories/protractor-work-orders";
import type { LaborFact } from "./labor-reporting-aggregate";

/** Read only the canonical provider cache; never call a provider or backfill. */
export async function recoverLaborEvidence(rows: LaborFact[], deadlineAt: number) {
  const shops = new Map<number, LaborFact[]>();
  for (const row of rows) {
    if (row.provider !== "protractor") continue;
    if (!shops.has(row.shop_id)) shops.set(row.shop_id, []);
    shops.get(row.shop_id)!.push(row);
  }
  let recovered = 0;
  for (const [shopId, facts] of shops) {
    for (let offset = 0; offset < facts.length; offset += 300) {
      if (Date.now() >= deadlineAt) return recovered;
      const batch = facts.slice(offset, offset + 300);
      const identity = (row: LaborFact) => (row.source_ids || [])
        .filter((s: any) => s.system === "protractor" && ["invoice_id","work_order_id"].includes(s.idType))
        .map((s: any) => String(s.idValue));
      const ids = batch.flatMap(identity);
      if (!ids.length) continue;
      try {
        const docs = await findCachedWorkOrdersByIds(shopId, ids, { maxTimeMS: Math.min(2000, Math.max(1,deadlineAt-Date.now())) });
        const byId = new Map(docs.map(doc => [doc.workOrderId, doc]));
        for (const row of batch) {
          const doc = identity(row).map(id => byId.get(id)).find(Boolean);
          if (doc) { row.cached_source = doc; recovered++; }
        }
      } catch { return recovered; } // still disclose missing coverage
    }
  }
  return recovered;
}
