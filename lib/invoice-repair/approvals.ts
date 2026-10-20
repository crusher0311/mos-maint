import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { INVOICE_FENCE_LOCK } from "./fence";

export interface RepairApprovalBinding {
  action: "apply" | "rollback";
  planDigest: string;
  evidenceDigest: string;
}
const digestPattern = /^[a-f0-9]{64}$/;
function validate(binding: RepairApprovalBinding) {
  assert.ok(binding.action === "apply" || binding.action === "rollback");
  assert.match(binding.planDigest, digestPattern);
  assert.match(binding.evidenceDigest, digestPattern);
}
/** Trusted server use only, after authenticating the actor and independently
 * refreshing evidence. Does not accept an approvedBy request-body field. */
export async function recordRepairApproval(
  sql: ReturnType<typeof postgres>, actorId: string, binding: RepairApprovalBinding,
) {
  validate(binding); assert.ok(actorId.trim().length >= 8);
  return sql.begin(async tx => {
    await tx.unsafe("SELECT pg_advisory_xact_lock($1,$2)", [...INVOICE_FENCE_LOCK]);
    const id = randomUUID();
    await tx.unsafe(`INSERT INTO invoice_repair_approvals
      (id,actor,action,plan_digest,evidence_digest,expires_at)
      VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '5 minutes')`,
    [id, actorId, binding.action, binding.planDigest, binding.evidenceDigest]);
    return id;
  });
}
/** Every phase re-reads this persisted grant under repair exclusion.
 * Passing an arbitrary Approval object cannot authorize a write. */
export async function requireRepairApproval(tx: any, id: string, actorId: string, binding: RepairApprovalBinding) {
  validate(binding);
  const rows = await tx.unsafe(`SELECT id FROM invoice_repair_approvals
    WHERE id=$1 AND actor=$2 AND action=$3 AND plan_digest=$4 AND evidence_digest=$5
    AND revoked_at IS NULL AND approved_at<=clock_timestamp() AND expires_at>clock_timestamp()`,
  [id, actorId, binding.action, binding.planDigest, binding.evidenceDigest]);
  assert.equal(rows.length, 1, "Missing, changed, revoked or expired action-specific approval");
}
