"use client";
import { useState } from "react";
import type { TireDotResult } from "@/lib/tire-dot-report-contract";
import { tireAdvisorAnalysis } from "@/lib/tire-dot-advisors";

export function TireDotAdvisorPanel({ result }: { result: TireDotResult }) {
  const [page, setPage] = useState(1);
  const groups = tireAdvisorAnalysis(result);
  const pages = Math.max(1, Math.ceil(groups.length / 25));
  const current = Math.min(page, pages);
  const cell = "border-b border-slate-100 px-4 py-3 text-left align-top text-xs";
  return <section className="panel p-4" aria-label="Service advisor analysis">
    <h3 className="font-bold">Service advisor analysis</h3>
    <p className="my-3 text-xs leading-5">Executed report only, grouped by location and assigned service advisor—not technician or proven DOT entry author.
      Each sold-tire invoice counts once per category; categories overlap. Flagged rate uses assessed invoices only.
      Missing assignment or validation remains unavailable, never assumed clean. Fewer than 10 assessed invoices is a small sample.
      Format checks do not verify tire identity; missing captured evidence does not prove missing data in Tekmetric.
      Report coverage limitations above also apply here.</p>
    {groups.length ? <div className="overflow-x-auto"><table aria-label="Service advisor quality" className="w-full border-collapse">
      <thead><tr>{["Location", "Service advisor", "Tire invoices", "Assessed", "Missing DOT", "Invalid DOT", "Needs review",
        "Usable count mismatch", "Flagged invoices", "Flagged rate", "Not assessed", "Inherited evidence", "Review invoices"].map(h => <th className={cell} scope="col" key={h}>{h}</th>)}</tr></thead>
      <tbody>{groups.slice((current - 1) * 25, current * 25).map(g => <tr key={g.key}>
        <td className={cell}>{g.location} #{g.shopId}</td><th scope="row" className={cell}>{g.advisor}</th>
        {[g.invoices, g.assessed, g.missing, g.invalid, g.review, g.shortage, g.flagged].map((n, i) => <td className={cell} key={i}>{n}</td>)}
        <td className={cell}>{g.assessed ? `${(100 * g.flagged / g.assessed).toFixed(1)}%${g.assessed < 10 ? " · Small sample" : ""}` : "Not assessed"}</td>
        <td className={cell}>{g.unassessed}</td><td className={cell}>{g.inherited}</td>
        <td className={cell}>{g.invoiceNumbers.length ? <details><summary>Show flagged invoices</summary>{g.invoiceNumbers.join(", ")}</details> : "None flagged"}</td>
      </tr>)}</tbody>
    </table></div> : <p>No sold-tire invoices in this execution.</p>}
    <div className="flex gap-3 mt-3"><button type="button" className="action secondary" disabled={current <= 1} onClick={() => setPage(current - 1)}>Previous advisors</button>
      <span>Page {current} of {pages}</span><button type="button" className="action secondary" disabled={current >= pages} onClick={() => setPage(current + 1)}>Next advisors</button></div>
  </section>;
}
