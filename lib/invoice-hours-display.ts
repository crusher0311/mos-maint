/** Shared display semantics for governed custom views and saved deliveries. */
export const INVOICE_HOURS_LABELS: Record<string, string> = {
  averagePresentedHoursPerInvoice: "Average hours presented",
  averageSoldHoursPerInvoice: "Average hours sold",
  invoiceCount: "Eligible invoices",
  invoicePopulationUnknown: "Unverified invoice records",
  invoiceSoldHours: "Covered sold hours",
  invoicePresentedHours: "Covered presented hours",
  invoiceSoldCovered: "Invoices with sold-hours evidence",
  invoicePresentedCovered: "Invoices with presented-hours evidence",
};
export function invoiceHoursDisplay(key: string, values: Record<string, number | null | undefined>): string | undefined {
  if (!["averagePresentedHoursPerInvoice", "averageSoldHoursPerInvoice"].includes(key)) return undefined;
  const count = values.invoiceCount;
  const covered = values[key === "averagePresentedHoursPerInvoice" ? "invoicePresentedCovered" : "invoiceSoldCovered"];
  const unknown = values.invoicePopulationUnknown;
  if (count === 0 && unknown === 0) return "No data";
  const value = values[key];
  if (value == null || unknown !== 0 || covered !== count) {
    return `Incomplete data (${covered ?? "unknown"}/${count ?? "unknown"} invoices covered${unknown !== 0 ? "; invoice population uncertain" : ""})`;
  }
  return `${value.toFixed(2)} hours / invoice`;
}
