"use client";

import React, { useState } from "react";
import type { TerminalHistorySummary } from "@/lib/data/repositories/terminal-history-imports";
import type { HistoryPageRequest } from "@/lib/data/repositories/terminal-history-pagination";

export function TerminalHistoryImportsView({ data, busy = false, onPage }: {
  data: TerminalHistorySummary; busy?: boolean; onPage?: (page: HistoryPageRequest) => void;
}) {
  const button = (label: string, page: HistoryPageRequest) => onPage &&
    <button type="button" disabled={busy} onClick={() => onPage(page)}
      className="rounded border px-3 py-2 text-sm disabled:opacity-50">{label}</button>;
  return <div className="space-y-4">
    <p className="text-sm text-gray-600">Up to {data.limits.campaigns} terminal campaigns, ordered by campaign ID.
      Receipt counts cover at most {data.limits.receipts} receipts on the displayed page per campaign, not campaign or fleet totals.
      Recorded unresolved units can include both days and invoices; do not add these counts together.</p>
    {data.campaignsTruncated && <p role="status">More terminal campaigns exist outside this summary.</p>}
    {data.nextCampaignCursor && button("Older campaigns", { campaignAfter: data.nextCampaignCursor })}
    {!data.campaigns.length && <p>No terminal history campaigns found.</p>}
    {data.campaigns.map(c => <article key={c.campaignId} className="rounded border p-3 space-y-2">
      <h3 className="font-medium">{c.campaignId} — {c.status}</h3>
      <p className="text-sm">Ended: {c.endedAt ?? "Not recorded"} · Recorded unresolved units: {c.recordedUnresolved}</p>
      <p>Imported: {c.outcomes.imported} · Verified present: {c.outcomes.verifiedPresent}</p>
      <p className="text-amber-800">Ambiguous receipts: {c.outcomes.ambiguous} · Needs index review: {c.outcomes.indexReview}
        {" · "}Thin receipts: {c.outcomes.thin} · Unknown receipts: {c.outcomes.unknown}</p>
      <p className="text-sm">{c.receiptsSampled} receipts on this page{c.receiptsTruncated ? " — truncated; more receipts remain" : " — last receipt page"}.
        {c.receiptAfter ? " Earlier receipt pages are excluded from these counts." : ""}
        {" "}Ambiguous means processing or prior-ambiguous, not proof of import success or failure.</p>
      {c.nextReceiptCursor && button("Next receipts", { campaignId: c.campaignId, shopAfter: c.shopAfter, receiptAfter: c.nextReceiptCursor })}
      {c.receiptAfter && button("First receipt page", { campaignId: c.campaignId, shopAfter: c.shopAfter })}
      <h4 className="font-medium">Held days by shop</h4>
      {c.shopAfter && <p className="text-sm">Earlier shop pages are not displayed.</p>}
      {c.shops.filter(s => s.heldDays.length || s.recordedUnresolved || s.heldDaysTruncated).map(s =>
        <p key={s.shopId} className="text-sm">Shop {s.shopId}: {s.heldDays.length ? s.heldDays.join(", ") : "No held days recorded"}
          {s.heldDaysTruncated ? " (more held days omitted)" : ""} · Recorded unresolved units: {s.recordedUnresolved}</p>)}
      {!c.shops.some(s => s.heldDays.length || s.recordedUnresolved || s.heldDaysTruncated) && <p>No held days or unresolved units in sampled shop metadata.</p>}
      {c.shopsTruncated && <p>Shop list truncated; additional held days may exist.</p>}
      {c.nextShopCursor && button("Next shops", { campaignId: c.campaignId, shopAfter: c.nextShopCursor, receiptAfter: c.receiptAfter })}
      {c.shopAfter && button("First shop page", { campaignId: c.campaignId, receiptAfter: c.receiptAfter })}
    </article>)}
  </div>;
}

export default function TerminalHistoryImports() {
  const [data, setData] = useState<TerminalHistorySummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function load(page: HistoryPageRequest = {}) {
    setBusy(true); setError(false);
    try {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(page)) if (value !== undefined) query.set(key, value);
      const response = await fetch(`/api/platform-admin/terminal-history-imports?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Unavailable");
      const next: TerminalHistorySummary = await response.json();
      if (page.campaignId && !next.campaigns.length) throw new Error("Campaign unavailable");
      setData(current => page.campaignId && current
        ? { ...current, campaigns: current.campaigns.map(c => c.campaignId === page.campaignId ? next.campaigns[0] : c) }
        : next);
    } catch { setData(null); setError(true); }
    finally { setBusy(false); }
  }
  return <section className="rounded-lg border bg-white p-4 space-y-3">
    <h2 className="font-semibold text-lg">Terminal history imports — unresolved work</h2>
    <p className="text-sm text-gray-600">Read-only bookkeeping, separate from active-campaign stall alerts.
      Held days are not completed imports. This summary never retries invoices, overwrites data, or authorizes another import.</p>
    <button type="button" disabled={busy} onClick={() => load()} className="rounded border px-3 py-2 text-sm disabled:opacity-50">
      {busy ? "Loading summary…" : "Load / refresh newest campaigns"}
    </button>
    {error && <p role="alert">History import summary unavailable. No import state was changed. Try refreshing.</p>}
    {data && !busy && <TerminalHistoryImportsView data={data} busy={busy} onPage={load} />}
  </section>;
}
