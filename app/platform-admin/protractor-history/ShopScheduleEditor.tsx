"use client";
import React from "react";
import { scheduleSource, statusLabel, type HistoryConfig, type HistoryShop } from "./history-client";

const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const input = "rounded border border-gray-300 p-2 text-sm disabled:bg-gray-100";

export function ShopScheduleEditor({ shop, draft, change }: {
  shop: HistoryShop; draft: HistoryConfig; change: (patch: Partial<HistoryConfig>) => void;
}) {
  const override = draft.shopSchedules?.find(s => s.shopId === shop.shopId);
  function update(patch: Partial<NonNullable<HistoryConfig["shopSchedules"]>[number]>) {
    const next = { shopId: shop.shopId, timezone: null, week: structuredClone(draft.week), ...override, ...patch };
    change({ shopSchedules: [...(draft.shopSchedules || []).filter(s => s.shopId !== shop.shopId), next] });
  }
  return <details className="rounded-lg border border-gray-200 p-4">
    <summary className="cursor-pointer font-medium">{shop.name} — {override ? "Shop-specific hours" : "Shared hours"}</summary>
    <p className="my-3 text-sm">Saved effective timezone: <strong>{shop.schedule?.timezone || "Needs review"}</strong>
      {" · "}{scheduleSource(shop.schedule?.source)}
      {shop.schedule?.issue && ` · ${statusLabel(shop.schedule.issue)}`}</p>
    <p className="mb-3 text-xs text-gray-600">Provider timezone comes from retained location metadata, not a new API call. Changes below are drafts until Save configuration. Business hours block imports; closed days allow off-hours work.</p>
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={!!override} onChange={e => {
        if (e.target.checked) update({});
        else if (window.confirm(`Remove the hours and timezone override for ${shop.name} and use the shared policy?`))
          change({ shopSchedules: draft.shopSchedules?.filter(s => s.shopId !== shop.shopId) });
      }} /> Use shop-specific scheduling
    </label>
    {override && <div className="mt-4 space-y-3">
      <label className="block text-sm">Timezone override (optional)
        <input className={`${input} mt-1 block w-full`} aria-label={`Timezone override for ${shop.name}`}
          value={override.timezone || ""} placeholder="Automatic from shop / Protractor"
          onChange={e => update({ timezone: e.target.value.trim() || null })} />
      </label>
      <p className="text-xs text-gray-600">Leave blank to use the saved shop setting, verified Protractor timezone, or confirmed fallback. Overrides do not change the shop’s general timezone.</p>
      {override.week.map(row => <div key={row.day} className="flex flex-wrap items-center gap-3">
        <span className="w-24 text-sm">{days[row.day]}</span>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={row.closed}
          onChange={e => update({ week: override.week.map(d => d.day === row.day ? { ...d, closed: e.target.checked } : d) })} />Closed</label>
        <input type="time" className={input} disabled={row.closed} value={row.open}
          aria-label={`${shop.name} ${days[row.day]} opens`}
          onChange={e => update({ week: override.week.map(d => d.day === row.day ? { ...d, open: e.target.value } : d) })} />
        <span>to</span>
        <input type="time" className={input} disabled={row.closed} value={row.close}
          aria-label={`${shop.name} ${days[row.day]} closes`}
          onChange={e => update({ week: override.week.map(d => d.day === row.day ? { ...d, close: e.target.value } : d) })} />
      </div>)}
    </div>}
  </details>;
}
