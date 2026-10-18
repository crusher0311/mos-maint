/** Local-preview policy only. Never infer non-invoice status from a missing number alone. */
const stages = new Set([
  "Unassigned", "ScheduledWork", "CheckedIn", "EstimateCompleted", "WorkAuthorized",
  "InspectionInProgress", "InspectionCompleted", "WaitingForParts", "WaitingForApproval",
  "WorkInProgress", "WorkPaused", "WorkCompleted",
]);
export function reviewUninvoiced(ids: string[], raws: any[], hasInvoiceEvidence: boolean) {
  if (hasInvoiceEvidence) return "invoice_evidence_present";
  if (!ids.length || !raws.length) return "missing_source";
  for (const raw of raws) {
    if (!raw?.ID || !ids.includes(String(raw.ID).toLowerCase())) return "identity_unverified";
    if (!["WorkOrder", "Estimate"].includes(raw.Type)) return "type_unverified";
    if (!stages.has(raw.WorkflowStage)) return "stage_unverified";
    // Missing, malformed, negative and positive numbers are not an explicit zero.
    if (!(raw.InvoiceNumber === 0 || raw.InvoiceNumber === "0")) return "number_unverified";
    if (raw.InvoiceTime != null && raw.InvoiceTime !== "" &&
        !/^0001-01-01T00:00:00(?:\.0+)?Z?$/.test(String(raw.InvoiceTime)))
      return "invoice_date_present";
  }
  return "verified_stored_uninvoiced";
}

/** Aggregate only allowlisted vocabulary: never persist arbitrary payload text. */
export function uninvoicedShape(raws: any[]) {
  return [...new Set(raws.map(raw => JSON.stringify({
    type: ["WorkOrder", "Estimate", "Invoice"].includes(raw?.Type) ? raw.Type : "other_or_missing",
    stage: stages.has(raw?.WorkflowStage) || ["Invoice", "Invoiced", "Paid", "Closed", "Voided"].includes(raw?.WorkflowStage)
      ? raw.WorkflowStage : "other_or_missing",
    number: raw?.InvoiceNumber === 0 || raw?.InvoiceNumber === "0" ? "zero" :
      Number(raw?.InvoiceNumber) > 0 ? "positive" : "missing_or_invalid",
    date: !raw?.InvoiceTime ? "missing" : /^0001-01-01/.test(String(raw.InvoiceTime)) ? "sentinel" : "recorded",
  })))].sort();
}
