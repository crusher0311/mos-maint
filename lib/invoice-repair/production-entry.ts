import "server-only";
import assert from "node:assert/strict";
import {getSession} from "@/lib/auth";
import {openProductionRepairStore, type ProductionRepairConfig} from "./production-store";
import {recordRepairApproval} from "./approvals";
import {NativeInvoiceStore, type NativeRepairPlan} from "@/scripts/invoice-native-dual-store";
import {evidenceDigest} from "@/scripts/invoice-metadata-repair-plan";
import type {OriginalProposal} from "@/scripts/invoice-metadata-executor";

type Command =
  | {kind: "prepare"; original: OriginalProposal; expectedDigest: string; holdReviews: Record<number, string>}
  | {kind: "approve"; plan: NativeRepairPlan; action: "apply" | "rollback"}
  | {kind: "execute"; plan: NativeRepairPlan; action: "apply" | "rollback"; approvalId: string}
  | {kind: "inspect"; plan: NativeRepairPlan};

/** Server-only entry point, intentionally not registered as an HTTP route or
 * worker job. Deployment cannot activate it or install the control schema.
 * Configuration is trusted server input, not a browser-supplied target. */
export async function executeProductionInvoiceRepair(config: ProductionRepairConfig, command: Command) {
  assert.equal(config?.enabled, true, "Production invoice repair disabled");
  const session = await getSession();
  assert.ok(session?.isPlatformAdmin && !session.isTestAuth && !session.isImpersonation &&
    !session.mustChangePassword && session.email?.trim(),
    "Authenticated, non-impersonated platform administrator required");
  const actor = `platform-admin:${session.email.trim().toLowerCase()}`;
  command = structuredClone(command);
  assert.ok(["prepare", "approve", "execute", "inspect"].includes(command.kind));
  const {store, close} = await openProductionRepairStore(config);
  try {
    if (command.kind === "prepare")
      return await store.finalizeNative(command.original, command.expectedDigest, command.holdReviews);
    if (command.kind === "inspect") return await store.inspectNative(command.plan);
    assert.ok(command.action === "apply" || command.action === "rollback");
    if (command.kind === "approve") {
      await store.validateForApproval(command.plan, command.action);
      return {approvalId: await recordRepairApproval(store.sql, actor, {
        action: command.action, planDigest: evidenceDigest(command.plan),
        evidenceDigest: NativeInvoiceStore.evidenceDigest(command.plan),
      })};
    }
    await store.executeNative(command.plan, command.action, command.approvalId, actor);
    return await store.inspectNative(command.plan);
  } catch {
    // SQL errors can contain native row values. Also, a rejected response does
    // not prove neither store committed. Keep persisted receipts authoritative.
    throw Error("Invoice repair outcome requires inspection; recheck approval, holds and persisted operation state");
  } finally {
    await close().catch(() => { throw Error("Invoice repair connection cleanup failed; inspect persisted operation state"); });
  }
}
