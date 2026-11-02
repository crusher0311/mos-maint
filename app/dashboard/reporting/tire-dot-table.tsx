import type { TireDotDetail, TireDotInvoice } from "@/lib/tire-dot-report-contract";
import { legacyDotQuality } from "@/lib/tire-dot-quality";
import { tirePostedDay } from "./tire-dot-presentation";

const display = (value: unknown) => value == null || value === "" ? "—" : String(value);
const cell = "border-b border-slate-100 px-4 py-3 text-left align-top text-xs";
export function TireDotTable({ rows, invoices, timeZones, caption }: {
  rows: (TireDotDetail | TireDotInvoice)[]; invoices: boolean;
  timeZones?: Record<string, string>; caption: string;
}) {
  const headings = ["Location / invoice", timeZones === undefined ? "Posted date (UTC)" : "Posted date (shop local time)",
    "Vehicle / VIN", "Year", "Make", "Model", "Invoice mileage",
    ...(invoices ? ["Part lines", "Tire quantity", "Recorded DOT entries", "Structurally usable DOT entries"]
      : ["Part / brand", "Quantity", "DOT", "Validation status", "Validation reason", "Source identifiers"]), "Exceptions"];
  return <div className="overflow-x-auto"><table className="w-full border-collapse">
    <caption className="sr-only">{caption}</caption>
    <thead className="bg-slate-50 text-slate-500"><tr>{headings.map(h => <th scope="col" className={`${cell} whitespace-nowrap font-bold`} key={h}>{h}</th>)}</tr></thead>
    <tbody>{rows.map(row => {
      const values = [
        tirePostedDay(row.postedDate, row.shopId, timeZones),
        <><span className="block">{display(row.vehicle)}</span><span className="block font-mono">{display(row.vin)}</span></>,
        display(row.year), display(row.make), display(row.model), display(row.mileage),
        ...("partLines" in row ? [row.partLines, row.tireQuantity, row.dotEntries, row.usableDotEntries ?? "Not assessed"]
          : [<>{display(row.description)}<br />{display(row.brand)}</>, row.quantity, display(row.dot),
            (row.dotQuality ?? legacyDotQuality).status, (row.dotQuality ?? legacyDotQuality).reason,
            <>Job {display(row.jobId)}<br />Part {display(row.partId)}<br />Entry {display(row.entryIndex)}</>]),
        row.exceptions.length ? <ul className="space-y-1 text-amber-800">{row.exceptions.map((e, i) => <li key={i}>{e}</li>)}</ul> : "None reported",
      ];
      return <tr key={row.key}><th scope="row" className={`${cell} min-w-40 font-normal`}><strong>{row.location}</strong><br />Invoice {display(row.invoiceNumber)}<br />Shop {row.shopId} · RO {row.providerRoId}</th>
        {values.map((value, i) => <td key={i} className={`${cell} min-w-28`}>{value}</td>)}</tr>;
    })}</tbody>
  </table></div>;
}
