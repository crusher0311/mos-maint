export interface WorkflowDviIdentity {
  version: 1;
  shopId: number;
  workflowVisitId: string;
  provider: "manual" | "protractor";
  providerWorkOrderId: string | null;
}
export interface BindingEvent {
  version: 1;
  id: string;
  actorId: string;
  source: "workflow-intake";
  at: string;
  reason: "bind" | "ticket-confirmed" | "import-alias";
  correlationId: string;
  before: WorkflowDviIdentity | null;
  after: WorkflowDviIdentity;
  aliases: string[];
}
export interface BindingAdmission {
  version: 1;
  requestId: string;
  digest: string;
  actorId: string;
  identity: WorkflowDviIdentity;
  aliases: string[];
  expectedBoardRevision: number;
  admittedBoardRevision: number;
  expectedInspectionRevision: number;
  at: string;
}
export interface BindingReceipt extends BindingAdmission {
  inspectionRevision: number;
}
export interface WorkflowInspection {
  identity: WorkflowDviIdentity;
  aliases: string[];
  revision: number;
  closed: boolean;
  /** Opaque local evidence. Binding must never replace inspection results. */
  results: Record<string, unknown>;
  receipts: BindingReceipt[];
  events: BindingEvent[];
}
/** No production adapter in S1. All reads are exact current-shop keys.
 * commit must atomically check revision, alias/provider uniqueness, immutable
 * identity, append receipt+events, preserve results, and advance revision.
 * On acknowledgment loss, read returns the committed receipt. */
export interface WorkflowInspectionRepository {
  read(shopId: number, workflowVisitId: string): Promise<WorkflowInspection | null>;
  commit(admission: BindingAdmission): Promise<"confirmed" | "conflict">;
}
export type BindingOutcome =
  | { status: "confirmed"; receipt: BindingReceipt }
  | { status: "conflict"; reason: string }
  | { status: "pending-local-finalization"; admission: BindingAdmission };
