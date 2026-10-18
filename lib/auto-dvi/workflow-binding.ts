import { z } from "zod";
import { digest, type Principal } from "../shop-dispatch/service";
import { idSchema, requireThat, type Board } from "../shop-dispatch/model";
import { assertHeldCapacityPreserved } from "../shop-dispatch/schedule-engine";
import { effectiveInspectionPermission, type InspectionAuthority } from "./workflow-policy";
import type { BindingAdmission, BindingOutcome, WorkflowDviIdentity, WorkflowInspectionRepository } from "./workflow-binding-contract";

const requestSchema = z.object({
  version: z.literal(1), requestId: z.string().uuid(), shopId: z.number().int().positive(),
  workflowVisitId: idSchema, expectedBoardRevision: z.number().int().nonnegative(),
  expectedInspectionRevision: z.number().int().nonnegative(),
}).strict(); // No VIN, RO, supplied provider ID or attachment references accepted.
export interface BindingDependencies {
  workflow: {
    read(shopId: number): Promise<Board>;
    save(shopId: number, revision: number, board: Board): Promise<boolean>;
  };
  inspections: WorkflowInspectionRepository;
  authority(p: Principal): Promise<InspectionAuthority>;
  now(): string;
}
function identityFor(board: Board, shopId: number, visitId: string): WorkflowDviIdentity {
  const visit = board.visits.find(v => v.id === visitId);
  requireThat(visit && !visit.closed, "Open workflow visit required", 409);
  const intent = board.ticketIntents?.find(i => i.visitId === visitId);
  requireThat(!intent || intent.status === "confirmed", "Recover the existing exact-ID ticket operation first", 409);
  requireThat(visit.provider === "manual" ? !visit.sourceId : !!visit.sourceId, "Invalid workflow source identity", 409);
  if (visit.sourceId) requireThat(z.string().uuid().safeParse(visit.sourceId).success, "Exact provider GUID required", 409);
  if (intent) requireThat(visit.sourceId === intent.workOrderId, "Ticket identity is not confirmed", 409);
  return { version: 1, shopId, workflowVisitId: visitId, provider: visit.provider, providerWorkOrderId: visit.sourceId };
}
/** Dark, local-only coordinator. Never calls intake creation/recovery or a
 * provider: callers recover tickets through the existing intake service first. */
export async function bindWorkflowInspection(p: Principal, raw: unknown, deps: BindingDependencies): Promise<BindingOutcome> {
  const req = requestSchema.parse(raw);
  async function authorize() {
    const a = await deps.authority(p);
    requireThat(p.shopId === req.shopId && !!a.actorId && effectiveInspectionPermission(a, req.shopId, "edit").allowed,
      "Current-shop inspection access required", 403);
    return a;
  }
  const authority = await authorize();
  const hash = digest(req);
  let board = await deps.workflow.read(req.shopId);
  let admission = board.dviAdmissions?.find(a => a.requestId === req.requestId);
  const conflict = (reason: string): BindingOutcome => ({ status: "conflict", reason });
  if (admission && (admission.digest !== hash || admission.actorId !== authority.actorId))
    return conflict("Request ID is already bound to different work");
  if (!admission) {
    if (board.revision !== req.expectedBoardRevision) return conflict("Workflow revision changed");
    const identity = identityFor(board, req.shopId, req.workflowVisitId);
    const current = await deps.inspections.read(req.shopId, req.workflowVisitId);
    if ((current?.revision ?? 0) !== req.expectedInspectionRevision || current?.closed) return conflict("Inspection revision changed or closed");
    for (const previous of board.dviAdmissions ?? []) {
      if (previous.identity.workflowVisitId !== req.workflowVisitId) continue;
      if (!current?.receipts.some(r => r.requestId === previous.requestId && r.digest === previous.digest))
        return conflict("Recover the existing local binding operation first");
    }
    admission = {
      version: 1, requestId: req.requestId, digest: hash, actorId: authority.actorId, identity,
      aliases: [...(board.visits.find(v => v.id === req.workflowVisitId)!.workflowAliases ?? [])].sort(),
      expectedBoardRevision: board.revision, admittedBoardRevision: board.revision + 1,
      expectedInspectionRevision: req.expectedInspectionRevision, at: deps.now(),
    };
    requireThat((board.dviAdmissions?.length ?? 0) < 5000 && board.audit.length < 5000, "Local binding retention review required", 409);
    const next = structuredClone(board);
    next.dviAdmissions = [...(next.dviAdmissions ?? []), admission];
    next.revision++; next.updatedAt = admission.at;
    next.audit.push({ at: admission.at, actor: authority.actorId, action: "dvi-binding-admitted",
      target: req.workflowVisitId, detail: "Local inspection binding; no provider write or customer release" });
    requireThat(next.visits.length <= 500 && next.jobs.length <= 2500 && Buffer.byteLength(JSON.stringify(next)) < 8 * 1024 * 1024, "Workflow storage capacity reached", 409);
    assertHeldCapacityPreserved(board, next, Date.parse(admission.at));
    await authorize();
    try {
      if (!await deps.workflow.save(req.shopId, board.revision, next)) return conflict("Workflow changed during admission");
    } catch {
      // Read the exact receipt after an ambiguous commit; never allocate a new ID.
      try {
        board = await deps.workflow.read(req.shopId);
        const saved = board.dviAdmissions?.find(a => a.requestId === req.requestId);
        if (!saved) return { status: "pending-local-finalization", admission };
        if (saved.digest !== hash || saved.actorId !== authority.actorId) return conflict("Request ID conflict");
        admission = saved;
      } catch { return { status: "pending-local-finalization", admission }; }
    }
  }
  await authorize(); // Includes retry after revoked membership.
  try {
    const current = await deps.inspections.read(req.shopId, req.workflowVisitId);
    const receipt = current?.receipts.find(r => r.requestId === req.requestId);
    if (receipt) {
      if (receipt.digest !== hash || receipt.actorId !== authority.actorId) return conflict("Inspection receipt conflict");
      await authorize();
      return { status: "confirmed", receipt };
    }
    board = await deps.workflow.read(req.shopId);
    // A changed source/closed visit must not be silently rebound on recovery.
    const identity = identityFor(board, req.shopId, req.workflowVisitId);
    if (digest(identity) !== digest(admission.identity)) return conflict("Workflow identity changed; explicit reconciliation required");
    await authorize();
    if (await deps.inspections.commit(admission) === "conflict") return conflict("Inspection binding changed; explicit reconciliation required");
    const saved = await deps.inspections.read(req.shopId, req.workflowVisitId);
    const savedReceipt = saved?.receipts.find(r => r.requestId === req.requestId && r.digest === hash);
    await authorize();
    return savedReceipt ? { status: "confirmed", receipt: savedReceipt } : { status: "pending-local-finalization", admission };
  } catch {
    // No errors, customer content or attachment URLs in receipts/audit.
    await authorize();
    return { status: "pending-local-finalization", admission };
  }
}
