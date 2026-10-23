import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { extractCallbackWorkOrderVin } from "./callback-vin";

export const normalizationRetriesEnabled = () =>
  process.env.PROTRACTOR_LOCAL_NORMALIZATION_RETRIES === "true";

const MAX_ATTEMPTS = 6;
export type NormalizationIntent = {
  id: string;
  shop_id: number;
  provider_id: string;
  payload: any;
  claim_token: string;
  attempts: number;
};

// Stable content identity independent of object property insertion order.
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateNormalizationPayload(shopId: number, providerId: string, payload: any) {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(providerId) ||
      typeof payload?.ID !== "string" || payload.ID.toLowerCase() !== providerId.toLowerCase() ||
      !extractCallbackWorkOrderVin(payload)) {
    throw new Error("Normalization intent identity rejected");
  }
}

/** This commit must succeed before the callback can acknowledge its work. */
export async function retainNormalizationIntent(pg: Sql, shopId: number, providerId: string, payload: any) {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error("Normalization payload exceeds limit");
  const retained = JSON.parse(json);
  validateNormalizationPayload(shopId, providerId, retained);
  const hash = createHash("sha256").update(canonical(retained)).digest("hex");
  const [row] = await pg`
    INSERT INTO protractor_normalization_retries (shop_id, provider_id, payload_hash, payload)
    VALUES (${shopId}, ${providerId}::uuid, ${hash}, ${json}::text::jsonb)
    ON CONFLICT (shop_id, provider_id, payload_hash) DO UPDATE
      SET payload_hash = EXCLUDED.payload_hash
    RETURNING id::text, state`;
  return row;
}

export function assertNormalizationComplete(result: any): void {
  const families = ["serviceJobs", "lineItems", "payments", "inspections", "recommendations"];
  if (result?.workOrder?.success !== true ||
      families.some(k => !Array.isArray(result[k]) || result[k].some((r: any) => r?.success !== true))) {
    throw new Error("Normalization entity failed");
  }
}

export async function claimNormalizationIntent(pg: Sql): Promise<NormalizationIntent | undefined> {
  // Expired final attempts remain explicitly visible, including crashes.
  await pg`UPDATE protractor_normalization_retries
    SET state='terminal', failure_code='attempts_exhausted', claim_token=NULL,
        lease_until=NULL, updated_at=clock_timestamp()
    WHERE id IN (SELECT id FROM protractor_normalization_retries
      WHERE state='running' AND lease_until < clock_timestamp() AND attempts >= ${MAX_ATTEMPTS}
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100)`;
  const [row] = await pg`
    WITH candidate AS (
      SELECT id FROM protractor_normalization_retries
      WHERE attempts < ${MAX_ATTEMPTS}
        AND ((state='pending' AND available_at <= clock_timestamp())
          OR (state='running' AND lease_until < clock_timestamp()))
      ORDER BY available_at, id FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE protractor_normalization_retries q
      SET state='running', attempts=q.attempts+1, claim_token=${randomUUID()}::uuid,
          lease_until=clock_timestamp()+interval '90 seconds', updated_at=clock_timestamp()
      FROM candidate WHERE q.id=candidate.id
      RETURNING q.id::text, q.shop_id, q.provider_id::text, q.payload, q.claim_token::text, q.attempts`;
  return row as NormalizationIntent | undefined;
}

export type RetryDependencies = {
  eligible: (shopId: number) => Promise<{ enterpriseId?: string } | null>;
  normalize: (tx: Sql, intent: NormalizationIntent, enterpriseId?: string) => Promise<unknown>;
};

/** Row lock fences expired claimants; PG parent lock + provider guard fences
 * different source generations through the entire child write transaction.
 * Completion and all normalized PG writes commit together. */
export async function executeNormalizationIntent(pg: Sql, intent: NormalizationIntent, deps: RetryDependencies) {
  let failureCode = "normalization_failed";
  try {
    await pg.begin(async transaction => {
      const tx = transaction as unknown as Sql;
      // postgres-js transaction handles omit options; Drizzle needs the
      // parent connection's parsers but must execute on this scoped handle.
      Object.assign(tx, { options: pg.options });
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SET LOCAL idle_in_transaction_session_timeout = '60s'`;
      const [owned] = await tx`
        SELECT id FROM protractor_normalization_retries
        WHERE id=${intent.id} AND state='running' AND claim_token=${intent.claim_token}::uuid
          AND lease_until > clock_timestamp() FOR UPDATE`;
      if (!owned) return;
      validateNormalizationPayload(intent.shop_id, intent.provider_id, intent.payload);
      const shop = await deps.eligible(intent.shop_id);
      if (!shop) {
        failureCode = "shop_ineligible";
        throw new Error(failureCode);
      }
      assertNormalizationComplete(await deps.normalize(tx, intent, shop.enterpriseId));
      const rows = await tx`
        UPDATE protractor_normalization_retries SET state='completed', claim_token=NULL,
          lease_until=NULL, failure_code=NULL, updated_at=clock_timestamp()
        WHERE id=${intent.id} AND claim_token=${intent.claim_token}::uuid
          AND lease_until > clock_timestamp() RETURNING id`;
      if (!rows.length) throw new Error("Normalization lease expired");
    });
  } catch {
    // Never store raw provider/DB errors: they can contain customer data.
    const [row] = await pg`
      UPDATE protractor_normalization_retries
      SET state=CASE WHEN attempts >= ${MAX_ATTEMPTS} OR ${failureCode}='shop_ineligible'
                     THEN 'terminal' ELSE 'pending' END,
          failure_code=${failureCode}, claim_token=NULL, lease_until=NULL,
          available_at=clock_timestamp() + (LEAST(3600, 30 * power(2, attempts-1)) * interval '1 second'),
          updated_at=clock_timestamp()
      WHERE id=${intent.id} AND state='running' AND claim_token=${intent.claim_token}::uuid
      RETURNING state`;
    if (row?.state === "terminal") console.error("[NormalizationRetry] terminal failure", { code: failureCode });
  }
}

export async function drainNormalizationIntents(pg: Sql, deps: RetryDependencies, options: {
  budgetMs?: number; shouldStop?: () => boolean;
} = {}) {
  const deadline = Date.now() + Math.min(30_000, Math.max(0, options.budgetMs ?? 10_000));
  let processed = 0;
  while (processed < 5 && Date.now() < deadline && !options.shouldStop?.()) {
    const intent = await claimNormalizationIntent(pg);
    if (!intent) break;
    await executeNormalizationIntent(pg, intent, deps);
    processed++;
  }
  return { processed };
}
