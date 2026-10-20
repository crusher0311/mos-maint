import "server-only";
import { getSession } from "@/lib/auth";
import type { HoldRegistry, RepairScope } from "./hold-registry";
import type postgres from "postgres";
import { recordRepairApproval, type RepairApprovalBinding } from "./approvals";
import type { NativeInvoiceStore, NativeRepairPlan } from "@/scripts/invoice-native-dual-store";

async function actor() {
  const session = await getSession();
  if (!session?.isPlatformAdmin || session.isTestAuth || session.isImpersonation || session.mustChangePassword)
    throw Error("Authenticated, non-impersonated platform administrator required");
  // Principal is derived on the server. Caller cannot substitute approvedBy.
  return { actorId: `platform-admin:${session.email.trim().toLowerCase()}` };
}

/** Server-side entry point preparation only: no route, connection factory or
 * production activation is installed by this module. */
export async function placeAuthenticatedHold(registry: HoldRegistry, scope: RepairScope,
  input: Parameters<HoldRegistry["place"]>[2]) {
  return registry.place(scope, await actor(), input);
}
export async function resolveAuthenticatedHold(registry: HoldRegistry, scope: RepairScope,
  id: string, reference: string) {
  return registry.resolve(scope, await actor(), id, reference);
}
export async function reviewAuthenticatedHoldCoverage(registry: HoldRegistry, scope: RepairScope,
  inventoryDigest: string, reference: string) {
  return registry.review(scope, await actor(), inventoryDigest, reference);
}

/** The server repair coordinator, not a request handler's JSON body, must
 * supply a freshly verified binding. No executable production route exists. */
export async function recordAuthenticatedRepairApproval(sql: ReturnType<typeof postgres>, binding: RepairApprovalBinding) {
  const principal = await actor();
  return recordRepairApproval(sql, principal.actorId, binding);
}
export async function executeAuthenticatedNativeRepair(
  store: NativeInvoiceStore, plan: NativeRepairPlan, action: "apply" | "rollback", approvalId: string,
) {
  const principal = await actor();
  return store.executeNative(plan, action, approvalId, principal.actorId);
}
