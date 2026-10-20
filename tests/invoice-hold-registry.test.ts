import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HoldRegistry, requireHoldCoverage } from "../lib/invoice-repair/hold-registry";
import { recordRepairApproval, requireRepairApproval } from "../lib/invoice-repair/approvals";

export async function testHoldRegistry(sql: any) {
  const registry = new HoldRegistry(sql);
  const scope = { shopId: 9100, provider: "protractor" as const };
  const actor = { actorId: "fixture-authenticated-admin" };
  const source = "11111111-1111-4111-8111-111111111111";
  const inventory = "a".repeat(64);
  const check = (review: string, digest = inventory) => sql.begin((tx: any) =>
    requireHoldCoverage(tx, scope, [source], digest, review));
  await assert.rejects(check(randomUUID()), /coverage review/);
  let review = await registry.review(scope, actor, inventory, "reviewed-complete-fixture-inventory");
  assert.match(await check(review), /^[a-f0-9]{64}$/);
  await assert.rejects(check(review, "b".repeat(64)), /coverage review/);
  const hold = await registry.place(scope, actor, {
    sourceId: source, kind: "financial", reasonReference: "retained-financial-conflict",
  });
  await assert.rejects(check(review), /coverage review/, "Any registry mutation invalidates review");
  review = await registry.review(scope, actor, inventory, "fixture-inventory-review-with-hold");
  await assert.rejects(check(review), /Financial\/ownership hold/);
  await registry.resolve(scope, actor, hold, "independent-accounting-resolution");
  await assert.rejects(check(review), /coverage review/);
  await assert.rejects(registry.resolve(scope, actor, hold, "duplicate-resolution-ref"), /already resolved/);
  review = await registry.review(scope, actor, inventory, "fixture-review-after-resolution");
  assert.match(await check(review), /^[a-f0-9]{64}$/);
  await sql.unsafe("UPDATE invoice_repair_hold_reviews SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [review]);
  await assert.rejects(check(review), /coverage review/);
  await registry.place(scope, actor, {
    sourceId: null, kind: "ownership", reasonReference: "shop-wide-unresolved-ownership",
  });
  review = await registry.review(scope, actor, inventory, "review-with-shop-wide-hold");
  await assert.rejects(check(review), /Financial\/ownership hold/);
  await assert.rejects(sql.unsafe("DELETE FROM invoice_repair_holds WHERE id=$1", [hold]), /append\/resolution only/);
  await assert.rejects(sql.unsafe("UPDATE invoice_repair_holds SET source_id=null WHERE id=$1", [hold]), /immutable/);
  const binding = { action: "apply" as const, planDigest: "a".repeat(64), evidenceDigest: "b".repeat(64) };
  const approval = await recordRepairApproval(sql, actor.actorId, binding);
  await sql.begin((tx: any) => requireRepairApproval(tx, approval, actor.actorId, binding));
  for (const [principal, changed] of [
    ["forged-principal", binding],
    [actor.actorId, { ...binding, action: "rollback" }],
    [actor.actorId, { ...binding, planDigest: "c".repeat(64) }],
    [actor.actorId, { ...binding, evidenceDigest: "c".repeat(64) }],
  ] as const) {
    await assert.rejects(sql.begin((tx: any) => requireRepairApproval(tx, approval, principal, changed)), /action-specific approval/);
  }
  await sql.unsafe("UPDATE invoice_repair_approvals SET revoked_at=clock_timestamp() WHERE id=$1", [approval]);
  await assert.rejects(sql.begin((tx: any) => requireRepairApproval(tx, approval, actor.actorId, binding)), /action-specific approval/);
  console.log("Hold registry checks passed: default deny, reviewed coverage, mutation invalidation, expiry, individual and shop-wide holds");
}
