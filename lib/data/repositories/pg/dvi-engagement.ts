import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/drizzle";
import type { TekmetricDviRecord } from "@/lib/dvi-engagement";

/** Existing cache table and payload; no schema migration or cutover required. */
export async function recordTekmetricDviEvidence(
  shopId: number, roId: string, fields: Record<string, string>,
): Promise<void> {
  const pg = getDb();
  // Only the two application-owned fields can be written here. ISO UTC strings
  // compare chronologically; JSON merge preserves unrelated provider fields.
  for (const key of ["dviInspectionSharedAt", "dviInspectionViewReceivedAt"]) {
    const value = fields[key];
    if (!value) continue;
    await pg.execute(sql`
      INSERT INTO tekmetric_work_orders (shop_id, work_order_id, payload)
      VALUES (${shopId}, ${roId}, jsonb_build_object(${key}::text, ${value}::text))
      ON CONFLICT (shop_id, work_order_id) DO UPDATE
      SET payload = coalesce(tekmetric_work_orders.payload, '{}'::jsonb) ||
        jsonb_build_object(${key}::text,
          least(tekmetric_work_orders.payload ->> ${key}, ${value}::text))
    `);
  }
}

export async function findTekmetricDviEvidence(
  shopId: number, roIds: string[], budgetMs: number,
): Promise<TekmetricDviRecord[]> {
  const pg = getDb();
  return pg.transaction(async tx => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(Math.max(1, Math.floor(budgetMs)))}, true)`);
    const rows = await tx.execute(sql`
      SELECT work_order_id AS "workOrderId",
        payload ->> 'dviInspectionSharedAt' AS "dviInspectionSharedAt",
        payload ->> 'dviInspectionViewReceivedAt' AS "dviInspectionViewReceivedAt",
        payload #>> '{data,inspectionShareDate}' AS "inspectionShareDate"
      FROM tekmetric_work_orders
      WHERE shop_id = ${shopId} AND work_order_id IN (${sql.join(roIds.map(id => sql`${id}`), sql`, `)})
      LIMIT 300
    `);
    return Array.from(rows) as unknown as TekmetricDviRecord[];
  });
}
