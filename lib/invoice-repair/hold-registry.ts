import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { INVOICE_FENCE_LOCK } from "./fence";

type Query = { unsafe: (text: string, params?: any[]) => PromiseLike<any[]> };
export type RepairScope = { shopId: number; provider: "protractor" };
export type ReviewActor = { actorId: string };
const hash = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function validateScope(scope: RepairScope) {
  assert.ok(Number.isSafeInteger(scope.shopId) && scope.shopId > 0);
  assert.equal(scope.provider, "protractor");
}
function reference(value: string) {
  assert.ok(typeof value === "string" && value.trim().length >= 8 && value.length <= 300, "Evidence reference required");
}

/** All commands require an actor supplied by the server's authenticated
 * facade, never an approvedBy field taken from an HTTP request. */
export class HoldRegistry {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}
  private async change<T>(scope: RepairScope, actor: ReviewActor, work: (tx: Query) => Promise<T>) {
    validateScope(scope); reference(actor.actorId);
    return this.sql.begin(async tx => {
      await tx.unsafe("SELECT pg_advisory_xact_lock($1,$2)", [...INVOICE_FENCE_LOCK]);
      await tx.unsafe(`INSERT INTO invoice_repair_hold_scopes(shop_id,provider)
        VALUES($1,$2) ON CONFLICT DO NOTHING`, [scope.shopId, scope.provider]);
      return work(tx as unknown as Query);
    }) as Promise<T>;
  }
  async place(scope: RepairScope, actor: ReviewActor, input: {
    sourceId: string | null; kind: "financial" | "ownership"; reasonReference: string;
  }) {
    reference(input.reasonReference);
    assert.ok(input.kind === "financial" || input.kind === "ownership");
    if (input.sourceId !== null) assert.match(input.sourceId, uuid);
    return this.change(scope, actor, async tx => {
      const id = randomUUID();
      await tx.unsafe(`INSERT INTO invoice_repair_holds
        (id,shop_id,provider,source_id,kind,reason_reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, scope.shopId, scope.provider, input.sourceId, input.kind, input.reasonReference, actor.actorId]);
      return id;
    });
  }
  async resolve(scope: RepairScope, actor: ReviewActor, id: string, resolutionReference: string) {
    reference(resolutionReference); assert.match(id, uuid);
    return this.change(scope, actor, async tx => {
      const rows = await tx.unsafe(`UPDATE invoice_repair_holds
        SET resolved_by=$1,resolution_reference=$2,resolved_at=clock_timestamp()
        WHERE id=$3 AND shop_id=$4 AND provider=$5 AND resolved_at IS NULL RETURNING id`,
      [actor.actorId, resolutionReference, id, scope.shopId, scope.provider]);
      assert.equal(rows.length, 1, "Hold missing, wrong scope or already resolved");
    });
  }
  async review(scope: RepairScope, actor: ReviewActor, inventoryDigest: string, reviewReference: string) {
    assert.match(inventoryDigest, hash); reference(reviewReference);
    return this.change(scope, actor, async tx => {
      const id = randomUUID();
      await tx.unsafe(`INSERT INTO invoice_repair_hold_reviews
        (id,shop_id,provider,scope_revision,inventory_digest,review_reference,actor,expires_at)
        SELECT $1,shop_id,provider,revision,$4,$5,$6,clock_timestamp()+interval '5 minutes'
        FROM invoice_repair_hold_scopes WHERE shop_id=$2 AND provider=$3`,
      [id, scope.shopId, scope.provider, inventoryDigest, reviewReference, actor.actorId]);
      return id;
    });
  }
}

/** Call inside the repair's exclusion transaction, before EVERY write phase.
 * The inventory digest must come from a fresh complete evidence read, not the
 * request body. A reviewed empty registry still requires a current review. */
export async function requireHoldCoverage(
  tx: Query, scope: RepairScope, sourceIds: string[], inventoryDigest: string, reviewId: string,
) {
  validateScope(scope); assert.match(inventoryDigest, hash); assert.match(reviewId, uuid);
  assert.ok(sourceIds.length > 0 && sourceIds.length <= 100);
  sourceIds.forEach(id => assert.match(id, uuid));
  const reviews = await tx.unsafe(`SELECT r.id,r.scope_revision::text,r.inventory_digest
    FROM invoice_repair_hold_reviews r JOIN invoice_repair_hold_scopes s
    ON s.shop_id=r.shop_id AND s.provider=r.provider
    WHERE r.id=$1 AND r.shop_id=$2 AND r.provider=$3
    AND r.scope_revision=s.revision AND r.inventory_digest=$4
    AND r.reviewed_at<=clock_timestamp() AND r.expires_at>clock_timestamp()`,
  [reviewId, scope.shopId, scope.provider, inventoryDigest]);
  assert.equal(reviews.length, 1, "Missing, changed or expired hold coverage review");
  const holds = await tx.unsafe(`SELECT id FROM invoice_repair_holds
    WHERE shop_id=$1 AND provider=$2 AND resolved_at IS NULL
    AND (source_id IS NULL OR source_id=ANY($3::text[])) LIMIT 1`,
  [scope.shopId, scope.provider, sourceIds]);
  assert.equal(holds.length, 0, "Financial/ownership hold");
  return createHash("sha256").update(JSON.stringify(reviews[0])).digest("hex");
}
