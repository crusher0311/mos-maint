export type InvoiceHoursRow = {
  key: string;
  label: string;
  shopId?: number;
  current: Record<string, number | null>;
};

export type HoursSummary = {
  count: number | null;
  unknown: number | null;
  presented: { value: number | null; covered: number | null };
  sold: { value: number | null; covered: number | null };
};

function sum(rows: InvoiceHoursRow[], field: string): number | null {
  let total = 0;
  for (const row of rows) {
    const value = row.current[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return total;
}

/** Ratios of raw totals, never means of rounded location averages. */
export function summarizeInvoiceHours(rows: InvoiceHoursRow[]): HoursSummary {
  const count = sum(rows, "invoiceCount");
  const unknown = sum(rows, "invoicePopulationUnknown");
  const metric = (kind: "Presented" | "Sold") => {
    const covered = sum(rows, `invoice${kind}Covered`);
    const hours = sum(rows, `invoice${kind}Hours`);
    // Null per-row averages are authoritative coverage/population signals.
    const complete = rows.every(row => row.current.invoiceCount === 0
      || (typeof row.current[`average${kind}HoursPerInvoice`] === "number"
      && Number.isFinite(row.current[`average${kind}HoursPerInvoice`])));
    return { covered, value: count !== null && count > 0 && unknown === 0
      && covered === count && hours !== null && complete ? hours / count : null };
  };
  return { count, unknown, presented: metric("Presented"), sold: metric("Sold") };
}

export function hoursDisplay(value: number | null, count: number | null, unknown: number | null): string {
  if (count === 0 && unknown === 0) return "No data";
  return value === null ? "Incomplete data" : value.toFixed(2);
}
