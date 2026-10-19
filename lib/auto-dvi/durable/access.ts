import { listUsers } from "@/lib/data/repositories/users";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { DurableError, type Scope } from "./model";

/** Explicit, reviewed, expiring grants of operator capability, not a UI role.
 * Empty until separately approved. Does not enable provider capability/admission. */
export const RECOVERY_OPERATORS: ReadonlyArray<{shopId: number; actor: string; expiresAt: number}> = Object.freeze([]);

export async function assertDurableStaff(scope: Scope) {
  if (!scope.actor || !Number.isSafeInteger(scope.shopId) || scope.shopId <= 0)
    throw new DurableError("UNAUTHORIZED", 403);
  const users = await listUsers({email: scope.actor});
  const assigned = users.some(user => {
    if (user.disabled === true || user.active === false || user.mustChangePassword === true) return false;
    const ids = [user.shopId, ...(Array.isArray(user.shopIds) ? user.shopIds : [])];
    return ids.some(id => String(id) === String(scope.shopId));
  });
  // No platform-admin bypass: a current explicit shop assignment is required.
  if (!assigned || await checkShopFeatureGate(scope.shopId, ["maintenance", "auto_dvi"], {featureLabel: "Auto DVI"}))
    throw new DurableError("OPERATION_FORBIDDEN", 403);
}
export async function assertRecoveryOperator(scope: Scope) {
  await assertDurableStaff(scope);
  if (!RECOVERY_OPERATORS.some(p => p.shopId === scope.shopId && p.actor === scope.actor && p.expiresAt > Date.now()))
    throw new DurableError("OPERATOR_AUTHORIZATION_REQUIRED", 403);
}
