import native from "@/docs/reporting/jwt-701-september-1-native-identities.json";

/** Source capture only. This neither grants write authority nor performs repairs. */
export function captureApprovedRecoverySource(records: unknown) {
  if (!Array.isArray(records) || records.length > 25) throw new Error("Invalid source batch");
  const approved = native.filter(n => n.classification !== "included");
  if (approved.length !== 21) throw new Error("Approval scope changed");
  const ids = new Set<string>();
  const invoices = approved.map(n => {
    const matches = records.filter(r =>
      String(r?.WorkOrderNumber) === n.wo && String(r?.InvoiceNumber) === n.invoice);
    if (matches.length !== 1) throw new Error("Missing or duplicate approved source");
    const r = matches[0];
    const packages = Array.isArray(r.ServicePackages) ? r.ServicePackages : r.ServicePackages?.ItemCollection;
    if (!["WorkOrder", "Invoice"].includes(r.Type) || r.WorkflowStage !== "Invoice" ||
        (r.Status != null && !["Invoice", "Invoiced", "Paid", "Closed"].includes(r.Status)) ||
        typeof r.InvoiceTime !== "string" || !r.InvoiceTime.startsWith("2026-09-01T") ||
        !Number.isFinite(Date.parse(r.InvoiceTime)) ||
        new Date(r.InvoiceTime).toISOString().slice(0,10) !== "2026-09-01" ||
        typeof r.ID !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.ID) ||
        ids.has(r.ID.toLowerCase()) || !Array.isArray(packages)) {
      throw new Error("Source completeness or identity check failed");
    }
    ids.add(r.ID.toLowerCase());
    return r;
  });
  return {
    shopId: 227, location: "701", date: "2026-09-01", readOnly: true,
    capturedAt: new Date().toISOString(),
    validation: "Identity and basic source structure checked; full ingestion validation and fresh database conflict checks still required",
    invoices,
  };
}
