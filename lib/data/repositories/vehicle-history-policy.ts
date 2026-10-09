import { sql } from "drizzle-orm";
import { getDb as getMongoDb } from "@/lib/data/db";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { isIdentityPgCanonical } from "@/lib/db/wave4-write-mode";
import { DEFAULT_HISTORY_POLICY, type HistoryPolicy } from "@/lib/vehicle-history/model";

export interface HistoryEnterprise { id: string; shopIds: number[] }

/** Unlike legacy findOne, ambiguous memberships MUST NOT authorize sharing. */
export async function historyEnterprisesForShop(shopId: number): Promise<HistoryEnterprise[]> {
  if (isIdentityPgCanonical()) {
    const rows = await getPgDb().execute(sql`
      SELECT id, shop_ids FROM enterprise_accounts
      WHERE shop_ids @> ${JSON.stringify([shopId])}::jsonb
         OR shop_ids @> ${JSON.stringify([String(shopId)])}::jsonb LIMIT 2`);
    return Array.from(rows as any[]).map(r => ({ id: String(r.id), shopIds: r.shop_ids.map(Number) }));
  }
  const db = await getMongoDb();
  const rows = await db.collection("enterprise_accounts")
    .find({ shopIds: { $in: [shopId, String(shopId)] } }, { projection: { shopIds: 1 } })
    .limit(2).maxTimeMS(1500).toArray();
  return rows.map(r => ({ id: String(r._id), shopIds: (r.shopIds ?? []).map(Number) }));
}

/**
 * New feature state has one PG authority independent of identity cutover.
 * No shadow fallback: a missing migration is unavailable, never permission.
 */
export async function readHistoryPolicy(enterpriseId: string): Promise<HistoryPolicy> {
  const rows = await getPgDb().execute(sql`
    SELECT enabled, stage, shop_ids, revision
    FROM enterprise_vehicle_history_policies WHERE enterprise_id = ${enterpriseId}`);
  const r = (rows as any[])[0];
  return r ? { enabled: r.enabled, stage: r.stage, shopIds: r.shop_ids, revision: r.revision }
    : { ...DEFAULT_HISTORY_POLICY, shopIds: [] };
}

export async function saveHistoryPolicy(
  enterpriseId: string, policy: HistoryPolicy,
): Promise<HistoryPolicy | null> {
  // revision 0 creates exactly once; all later edits compare-and-swap.
  const rows = policy.revision === 0
    ? await getPgDb().execute(sql`
      INSERT INTO enterprise_vehicle_history_policies
        (enterprise_id, enabled, stage, shop_ids, revision)
      VALUES (${enterpriseId}, ${policy.enabled}, ${policy.stage}, ${JSON.stringify(policy.shopIds)}::jsonb, 1)
      ON CONFLICT (enterprise_id) DO NOTHING RETURNING revision`)
    : await getPgDb().execute(sql`
      UPDATE enterprise_vehicle_history_policies
      SET enabled = ${policy.enabled}, stage = ${policy.stage},
        shop_ids = ${JSON.stringify(policy.shopIds)}::jsonb,
        revision = revision + 1, updated_at = now()
      WHERE enterprise_id = ${enterpriseId} AND revision = ${policy.revision}
      RETURNING revision`);
  const row = (rows as any[])[0];
  return row ? { ...policy, revision: Number(row.revision) } : null;
}
