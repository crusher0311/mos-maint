/** A legacy writer cannot accept visit provenance as decoration around a
 * VIN-scoped payload. Visit export must load saved evidence at its own sink. */
export function hasVisitExportIdentity(raw: unknown): boolean {
  return !!raw && typeof raw === "object" &&
    ["visitId", "workflowVisitId", "evidenceRevision", "inspectionRevision"].some(key => key in raw);
}
export const VISIT_EXPORT_REQUIRED = "Use the selected visit's approved export controls. Legacy VIN findings cannot be submitted as visit evidence. Existing operation status and recovery remain available.";
