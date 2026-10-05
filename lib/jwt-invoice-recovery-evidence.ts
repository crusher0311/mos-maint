export interface StoredInvoiceEvidence {
  id: string;
  work_order_number: string;
  status: string | null;
  business_date: string | null;
  deleted: boolean;
}

export function recoveryEvidence(
  record: any, wo: string | null, invoice: string | null, matched: boolean,
  stored: StoredInvoiceEvidence[] | null,
) {
  const stage = (v: unknown) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(v) ? v : null;
  const stamp = (v: unknown) => typeof v === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-]\d\d:\d\d)?$/.test(v) &&
    Number.isFinite(Date.parse(v)) ? v : null;
  const workflowStage = stage(record?.WorkflowStage);
  const status = stage(record?.Status);
  const terminal = (v: string | null) => !!v && ["Closed", "Invoiced", "Paid"].includes(v);
  const sourceTerminal = ["WorkOrder", "Invoice"].includes(record?.Type) && terminal(workflowStage || status) &&
    (!workflowStage || !status || terminal(status));
  const exact = stored?.filter(r => r.work_order_number === wo) ?? [];
  const alternative = stored?.filter(r => r.work_order_number === invoice && r.work_order_number !== wo) ?? [];
  const current = stored === null ? "Unavailable — database comparison failed or was not configured" :
    !exact.length && !alternative.length ? "Absent by both numbers" :
    exact.length !== 1 || alternative.length ? "Ambiguous identity — manual review" :
    exact[0].deleted ? "Soft deleted — manual review" :
    `Status: ${exact[0].status ?? "unknown"}; business date: ${exact[0].business_date ?? "unknown"}`;
  let proposedAction = "Hold — source closure or identity/date not verified";
  if (matched && stamp(record?.InvoiceTime)?.slice(0, 10) === "2026-09-01" && sourceTerminal && stored !== null) {
    if (!exact.length && !alternative.length) proposedAction = "Candidate insert — retrieve and validate full source detail before approval";
    else if (exact.length !== 1 || alternative.length || exact[0].deleted) proposedAction = "Hold — identity conflict or soft deletion requires manual review";
    else if (["closed", "invoiced", "paid"].includes(exact[0].status ?? "") && exact[0].business_date === "2026-09-01")
      proposedAction = "No header recovery indicated — labor completeness not assessed";
    else proposedAction = `Candidate header update — status ${String(workflowStage || status).toLowerCase()}, invoice timestamp ${stamp(record?.InvoiceTime)}; validate business-date basis and full detail before approval`;
  } else if (stored === null) proposedAction = "Hold — current database evidence unavailable";
  return {
    workflowStage, status, invoiceTime: stamp(record?.InvoiceTime),
    createdTime: stamp(record?.Header?.CreationTime),
    modifiedTime: stamp(record?.Header?.LastModifiedTime),
    current, proposedAction,
  };
}
