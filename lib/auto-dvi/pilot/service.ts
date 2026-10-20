import { digest } from "../../shop-dispatch/service";
import { requireThat } from "../../shop-dispatch/model";
import { deriveIdempotentUpstreamId } from "../../idempotent-create-id";
import { assertBinding, currentVisit, type StaffDependencies } from "../staff/service";
import type { StaffInspection } from "../staff/model";
import { z } from "zod";
import { checkOrder, classifyPilot, inspectionPayload, PILOT_SHOP, pilotRequestSchema, project, riskNotice,
  SYNTHETIC_CONTACT, SYNTHETIC_VEHICLE, type PilotOperation } from "./model";

export interface PilotDependencies extends StaffDependencies {
  provider: {
    connection(): Promise<string>; // hashed identity, never credentials
    read(guid: string, connectionHash: string): Promise<Record<string, any>>;
    send(guid: string, payload: Record<string, any>, connectionHash: string): Promise<boolean>;
  };
}
async function context(visitId: string, deps: PilotDependencies, write: boolean, actor?: string) {
  const access = await deps.access();
  requireThat(access.shopId === PILOT_SHOP, "CAR Experts test instance only", 403);
  requireThat(!actor || access.actor === actor, "Signed-in account changed", 403);
  if (write) requireThat(access.canEdit && access.canReview && access.config?.pilot?.admissions,
    "Pilot sends require enabled advisor/manager/owner access", 403);
  const board = await deps.board.read(access.shopId);
  const visit = currentVisit(board, visitId);
  const record = await deps.repository.read(access.shopId, visitId);
  requireThat(record, "Initialize and save this visit's inspection first", 409);
  assertBinding(board, record, visitId, write);
  const intent = board.ticketIntents?.find(i => i.visitId === visitId);
  requireThat(visit.provider === "protractor" && z.string().uuid().safeParse(visit.sourceId).success,
    "An open Protractor ticket is required; create or recover its ticket first", 409);
  if (access.config?.pilot?.targetScope !== "shop_test_instance") requireThat(intent?.status === "confirmed" &&
    intent.workOrderId === visit.sourceId &&
    intent.workOrderId === deriveIdempotentUpstreamId("workOrder", PILOT_SHOP, "workflow-intake", visitId) &&
    intent.contactId === SYNTHETIC_CONTACT && intent.vehicleId === SYNTHETIC_VEHICLE &&
    intent.payload.contactId === SYNTHETIC_CONTACT && intent.payload.vehicleId === SYNTHETIC_VEHICLE &&
    !intent.payload.newCustomer && !intent.payload.newVehicle,
  "A newly checked-in synthetic fixture with a verified workflow-created ticket is required", 409);
  const inspection = record.results.staff as StaffInspection | undefined;
  requireThat(inspection, "Saved inspection required", 409);
  if (write) requireThat(inspection.reviewed?.revision === inspection.evidenceRevision, "Review the current saved evidence first", 409);
  return {access, record, inspection, guid: visit.sourceId!};
}
function publicOperation(op?: PilotOperation) {
  return op ? {id: op.id, visitId: op.visitId, workOrderGuid: op.guid, evidenceRevision: op.evidenceRevision,
    state: op.state, acknowledged: op.acknowledged, observedAt: op.observedAt,
    confirmedAt: op.confirmedAt,
    lines: op.lines, warning: riskNotice, recoveryAllowed: false} : null;
}
async function operations(deps: PilotDependencies, visitId: string) {
  return (await deps.repository.persistence.read(PILOT_SHOP)).pilotOperations?.filter(o => o.visitId === visitId) ?? [];
}
const chosen = (ops: PilotOperation[]) => ops.find(o => o.state !== "preview") ?? ops.at(-1);

export async function pilotStatus(visitId: string, deps: PilotDependencies) {
  const access = await deps.access();
  if (access.shopId !== PILOT_SHOP || !access.config?.pilot) return {enabled: false, canSend: false, operation: null, candidates: []};
  const {inspection, guid} = await context(visitId, deps, false, access.actor);
  const op = chosen(await operations(deps, visitId));
  return {enabled: access.config.pilot.admissions, canSend: access.canEdit && access.canReview &&
    access.config.pilot.admissions && inspection.reviewed?.revision === inspection.evidenceRevision,
    evidenceRevision: inspection.evidenceRevision, workOrderGuid: guid, warning: riskNotice,
    labelEvidence: access.config.pilot.labelEvidence, operation: publicOperation(op),
    candidates: inspection.sheets.filter(s => s.active).flatMap(s => s.sheet.items.filter(i =>
      s.results[i.id]?.rating && s.results[i.id].rating !== "na").map(i => ({sheet: s.key, item: i.id, name: i.name, rating: s.results[i.id].rating})))};
}
export async function executePilot(raw: unknown, deps: PilotDependencies) {
  const req = pilotRequestSchema.parse(raw);
  if (req.action === "reconcile") {
    await context(req.visitId, deps, false);
    const op = chosen(await operations(deps, req.visitId));
    requireThat(op && op.state !== "preview", "No admitted operation to verify; preview is not a send", 409);
    await reconcile(op, deps);
    return pilotStatus(req.visitId, deps);
  }
  // Exact replays only return persisted status, even after rollback; never send again.
  const initial = await context(req.visitId, deps, false);
  const old = await operations(deps, req.visitId);
  const existing = old.find(o => o.id === (req.action === "send" ? req.previewId : req.requestId));
  if (existing) {
    requireThat(existing.actor === initial.access.actor, "This request belongs to another staff member", 403);
    if (req.action === "preview") {
      requireThat(existing.requestHash === digest(req), "Request key already binds different evidence", 409);
      return {...await pilotStatus(req.visitId, deps), operation: publicOperation(existing)};
    }
    if (existing.state !== "preview") return pilotStatus(req.visitId, deps);
  }
  const current = await context(req.visitId, deps, true, initial.access.actor);
  const policy = current.access.config!.pilot!;
  requireThat(await deps.provider.connection() === policy.connectionHash, "Pilot provider connection changed", 409);
  const authorize = async () => {
    const latest = await context(req.visitId, deps, true, initial.access.actor);
    requireThat(digest(latest.access.config!.pilot) === digest(policy) && latest.guid === current.guid,
      "Pilot target or policy changed", 409);
    requireThat(await deps.provider.connection() === policy.connectionHash, "Pilot connection changed", 409);
  };
  if (req.action === "preview") {
    requireThat(current.inspection.evidenceRevision === req.evidenceRevision, "Saved evidence changed; reload and review", 409);
    const lines = project(current.inspection, req.selected, policy.labels);
    const baseline = checkOrder(await deps.provider.read(current.guid, policy.connectionHash), current.guid, policy.targetScope);
    const op: PilotOperation = {id: req.requestId, actor: initial.access.actor, visitId: req.visitId,
      targetScope: policy.targetScope ?? "synthetic_fixture",
      guid: current.guid, connectionHash: policy.connectionHash, requestHash: digest(req),
      evidenceRevision: req.evidenceRevision, evidenceHash: digest(current.inspection), policyHash: digest(policy),
      createdAt: deps.now(), selected: req.selected, lines, baseline, payload: inspectionPayload(lines),
      state: "preview", acknowledged: false, observedAt: null, confirmedAt: null};
    await deps.repository.mutatePilot(PILOT_SHOP, authorize, state => {
      const ops = state.pilotOperations ??= [];
      requireThat(!ops.some(o => o.id === op.id), "Preview request already exists; reload exact request", 409);
      requireThat(!ops.some(o => o.guid === op.guid && o.state !== "preview"), "This order already owns a send; use status verification", 409);
      const evidence = state.records.find(r => r.identity.workflowVisitId === req.visitId)?.results.staff;
      requireThat(digest(evidence) === op.evidenceHash, "Evidence changed during preview", 409);
      ops.push(op);
    });
    return {...await pilotStatus(req.visitId, deps), operation: publicOperation(op)};
  }
  requireThat(existing, "Saved preview required", 409);
  requireThat(Date.parse(deps.now()) - Date.parse(existing.createdAt) <= 15 * 60000, "Preview expired; review a new preview", 409);
  requireThat(existing.guid === current.guid && existing.policyHash === digest(policy), "Preview target or policy changed", 409);
  const before = checkOrder(await deps.provider.read(current.guid, policy.connectionHash), current.guid, existing.targetScope);
  requireThat(digest(before) === digest(existing.baseline), "Provider order changed since preview; preview again", 409);
  // Same aggregate CAS as staff edits: selection cannot race an evidence save.
  await deps.repository.mutatePilot(PILOT_SHOP, authorize, state => {
    const op = state.pilotOperations?.find(o => o.id === existing.id);
    requireThat(op?.state === "preview", "Send already admitted; reload status", 409);
    requireThat(!state.pilotOperations?.some(o => o.guid === current.guid && o.state !== "preview"), "Order already owns a send", 409);
    const evidence = state.records.find(r => r.identity.workflowVisitId === req.visitId)?.results.staff;
    requireThat(digest(evidence) === op.evidenceHash, "Evidence changed; review and preview again", 409);
    op.state = "admitted";
  });
  // Lost CAS acknowledgment exits above, never sends speculatively. An admitted
  // operation is never resumed by another HTTP request or worker.
  await authorize();
  let acknowledged = false;
  try { acknowledged = await deps.provider.send(existing.guid, existing.payload, existing.connectionHash); } catch { /* ambiguous: never replay */ }
  await recordObservation(existing, deps, acknowledged);
  return pilotStatus(req.visitId, deps);
}
async function recordObservation(op: PilotOperation, deps: PilotDependencies, acknowledged?: boolean) {
  let state: PilotOperation["state"] = "pending";
  try {
    requireThat(await deps.provider.connection() === op.connectionHash, "Connection changed", 409);
    state = classifyPilot(op, await deps.provider.read(op.guid, op.connectionHash));
  } catch { /* Unknown is not proof of absence or provider termination. */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await deps.repository.mutatePilot(PILOT_SHOP, async () => {
        await context(op.visitId, deps, false);
      }, aggregate => {
        const saved = aggregate.pilotOperations?.find(o => o.id === op.id);
        requireThat(saved && saved.state !== "preview", "Admitted operation not found", 409);
        // Preserve prior conflict/partial evidence; a later apparent match cannot
        // erase an intervening provider edit or certify termination.
        if (!["conflict", "partial"].includes(saved.state)) saved.state = state;
        saved.acknowledged ||= acknowledged === true;
        saved.observedAt = deps.now();
        if (state === "confirmed") saved.confirmedAt ??= saved.observedAt;
      });
      return;
    } catch (error) { if (attempt === 2) throw error; }
  }
}
async function reconcile(op: PilotOperation, deps: PilotDependencies) {
  await recordObservation(op, deps);
}
