import { z } from "zod";
import { commandSchema, type StaffInspection } from "./model";
import type { StaffRepository } from "./store";
import type { StaffAccess } from "./access";
import { bindWorkflowInspection, type BindingDependencies } from "../workflow-binding";
import { digest } from "../../shop-dispatch/service";
import { idSchema, requireThat, type Board } from "../../shop-dispatch/model";
import type { WorkflowInspection } from "../workflow-binding-contract";
import { terminalSourceStatus } from "../../shop-dispatch/source-preferences";
import type { ROArrivalPhotos } from "../../data/repositories/ro-arrival-photos";

export const staffRequestSchema = z.object({
  visitId: idSchema, requestId: z.string().uuid(), revision: z.number().int().nonnegative(),
  command: z.union([commandSchema, z.object({type: z.literal("initialize"), boardRevision: z.number().int().nonnegative()}).strict()]),
}).strict();
export interface StaffDependencies {
  access(): Promise<StaffAccess>;
  board: BindingDependencies["workflow"];
  repository: StaffRepository;
  now(): string;
  arrivalPhotos?: Pick<ROArrivalPhotos, "reference">;
}
export function currentVisit(board: Board, id: string) {
  const visit = board.visits.find(v => v.id === id);
  requireThat(visit, "Current canonical workflow visit not found", 404);
  return visit;
}
const visitClosed = (visit: Board["visits"][number]) => visit.closed ||
  (visit.provider === "protractor" && terminalSourceStatus(visit.sourceStatus));
export function assertBinding(board: Board, record: WorkflowInspection, visitId: string, write: boolean) {
  const visit = currentVisit(board, visitId);
  requireThat(record.identity.workflowVisitId === visit.id &&
    record.identity.provider === visit.provider && record.identity.providerWorkOrderId === visit.sourceId,
  "Inspection identity changed. Explicit reconciliation is required.", 409);
  if (write) {
    requireThat(!visitClosed(visit) && !record.closed, "Closed visits are read-only", 409);
    const intent = board.ticketIntents?.find(i => i.visitId === visitId);
    requireThat(!intent || (intent.status === "confirmed" && intent.workOrderId === visit.sourceId),
      "Recover the existing ticket operation first", 409);
  }
}
export async function snapshot(visitId: string, deps: StaffDependencies) {
  const access = await deps.access(), board = await deps.board.read(access.shopId);
  const visit = currentVisit(board, visitId), record = await deps.repository.read(access.shopId, visitId);
  if (record) assertBinding(board, record, visitId, false);
  const latest = await deps.access();
  requireThat(latest.shopId === access.shopId && latest.actor === access.actor, "Access changed", 403);
  const unresolved = board.dviAdmissions?.find(a => a.identity.workflowVisitId === visitId &&
    !record?.receipts.some(r => r.requestId === a.requestId && r.digest === a.digest));
  return {enabled: latest.enabled, record, inspection: (record?.results.staff as StaffInspection) ?? null,
    catalog: latest.config?.sheets ?? [], canEdit: latest.canEdit && !visitClosed(visit) && !unresolved,
    canReview: latest.canReview && latest.canEdit && !visitClosed(visit),
    boardRevision: board.revision,
    ...(unresolved ? {bindingRequest: unresolved.actorId === latest.actor ? {
      version: 1, shopId: access.shopId, workflowVisitId: visitId, requestId: unresolved.requestId,
      expectedBoardRevision: unresolved.expectedBoardRevision, expectedInspectionRevision: unresolved.expectedInspectionRevision,
    } : null, error: "Inspection linking is pending. Recover the original request; do not create another ticket."} : {}),
  };
}
export async function writeContext(visitId: string, deps: StaffDependencies, original?: {actor: string; shopId: number; identity?: unknown}) {
  const access = await deps.access();
  requireThat(access.canEdit && access.config, "Staff inspection edits are disabled or not permitted", 403);
  requireThat(!original || (original.actor === access.actor && original.shopId === access.shopId), "Access changed", 403);
  const board = await deps.board.read(access.shopId), visit = currentVisit(board, visitId);
  requireThat(!visitClosed(visit), "Closed visits are read-only", 409);
  const record = await deps.repository.read(access.shopId, visitId);
  requireThat(record, "Inspection binding required", 409);
  assertBinding(board, record, visitId, true);
  requireThat(!original?.identity || digest(original.identity) === digest(record.identity), "Identity changed during save", 409);
  return {access, board, record};
}
export async function mutateStaff(raw: unknown, deps: StaffDependencies) {
  const req = staffRequestSchema.parse(raw), access = await deps.access();
  requireThat(access.canEdit && access.config, "Staff inspection edits are disabled or not permitted", 403);
  if (req.command.type === "initialize") {
    const board = await deps.board.read(access.shopId);
    requireThat(!visitClosed(currentVisit(board, req.visitId)), "Closed visits are read-only", 409);
    const existing = await deps.repository.read(access.shopId, req.visitId);
    const pending = board.dviAdmissions?.find(a => a.identity.workflowVisitId === req.visitId &&
      !existing?.receipts.some(r => r.requestId === a.requestId && r.digest === a.digest));
    // One request identity survives both local stores; initialize is the only
    // command permitted to share its ID with a binding receipt.
    const bindingId = req.requestId;
    const oldAdmission = board.dviAdmissions?.find(a => a.requestId === bindingId);
    requireThat(!oldAdmission || oldAdmission.expectedBoardRevision === req.command.boardRevision, "Original binding request payload required", 409);
    requireThat(!pending || pending.requestId === bindingId, "Recover the original inspection linking request", 409);
    if (!existing || oldAdmission || pending) {
      const outcome = await bindWorkflowInspection({shopId: access.shopId, email: access.email, role: "staff"}, {
        version: 1, shopId: access.shopId, workflowVisitId: req.visitId, requestId: bindingId,
        expectedBoardRevision: oldAdmission?.expectedBoardRevision ?? req.command.boardRevision,
        expectedInspectionRevision: oldAdmission?.expectedInspectionRevision ?? existing?.revision ?? 0,
      }, {workflow: deps.board, inspections: deps.repository, now: deps.now, authority: async () => {
        const latest = await deps.access();
        requireThat(latest.canEdit && latest.actor === access.actor && latest.shopId === access.shopId, "Access changed", 403);
        return latest.authority;
      }});
      requireThat(outcome.status === "confirmed", outcome.status === "conflict" ? outcome.reason : "Inspection linking pending; retry this exact request", outcome.status === "conflict" ? 409 : 503);
    }
  }
  const context = await writeContext(req.visitId, deps, access);
  let arrivalPhoto;
  if (req.command.type === "associate-arrival") {
    const identity = context.record.identity;
    requireThat(identity.provider === "protractor" && identity.providerWorkOrderId && deps.arrivalPhotos,
      "Arrival documentation requires a linked Protractor visit", 409);
    arrivalPhoto = {...await deps.arrivalPhotos.reference(access.shopId, identity.providerWorkOrderId, req.command.mediaId),
      actor: access.actor, at: deps.now()};
  }
  await deps.repository.mutate({
    shopId: access.shopId, visitId: req.visitId, requestId: req.requestId, expectedRevision: req.revision,
    actor: access.actor, at: deps.now(), command: req.command.type === "initialize" ? {type: "initialize"} : req.command,
    catalog: context.access.config!.sheets, defaultSheet: context.access.config!.defaultSheet, canReview: context.access.canReview, arrivalPhoto,
    authorize: async () => {
      const latest = await writeContext(req.visitId, deps, {...access, identity: context.record.identity});
      requireThat(digest(latest.access.config) === digest(context.access.config), "Inspection policy changed; reload", 409);
      if (req.command.type === "review" || req.command.type === "proposal") requireThat(latest.access.canReview, "Advisor review permission required", 403);
    },
  });
  return snapshot(req.visitId, deps);
}
