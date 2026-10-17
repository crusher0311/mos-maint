"use client";

import { useEffect, useState } from "react";

export function LocationSelection({ scope, value, onChange, onLoaded }: {
  scope: { kind: string; shopId?: number; enterpriseId?: string };
  value?: number[];
  onChange: (ids: number[] | undefined) => void;
  onLoaded?: (locations: Array<{ key: string; label: string }>) => void;
}) {
  const [locations, setLocations] = useState<Array<{ key: string; label: string }>>([]);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLocations([]); setError("");
    const params = new URLSearchParams({ scope: scope.kind });
    if (scope.shopId) params.set("shopId", String(scope.shopId));
    if (scope.enterpriseId) params.set("enterpriseId", scope.enterpriseId);
    void fetch(`/api/reports/locations?${params}`, { signal: abort.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Locations unavailable");
        const data = await response.json();
        if (!Array.isArray(data.locations)) throw new Error("Locations unavailable");
        if (!abort.signal.aborted) { setLocations(data.locations); onLoaded?.(data.locations); }
      }).catch(() => { if (!abort.signal.aborted) setError("Could not load authorized locations."); });
    return () => abort.abort();
  }, [scope.kind, scope.shopId, scope.enterpriseId, attempt, onLoaded]);
  const ids = locations.map(item => Number(item.key));
  return <fieldset className="rounded border border-slate-200 p-3">
    <legend className="text-xs font-bold">Locations · {scope.enterpriseId ? `Enterprise ${scope.enterpriseId}` : scope.kind === "platform" ? "Platform-wide" : "This location"}</legend>
    <label className="block text-xs"><input type="checkbox" checked={value === undefined} onChange={event => onChange(event.target.checked ? undefined : [])} /> All authorized locations in this scope</label>
    <div className="mt-2 max-h-40 overflow-auto">
      {locations.map(item => <label key={item.key} className="block py-1 text-xs">
        <input type="checkbox" checked={value === undefined || value.includes(Number(item.key))} onChange={event => {
          const selected = value ?? ids;
          onChange(event.target.checked ? [...selected, Number(item.key)].sort((a,b) => a-b) : selected.filter(id => id !== Number(item.key)));
        }} /> {item.label}
      </label>)}
    </div>
    <p className="mt-2 text-xs">{value === undefined ? `${locations.length} authorized locations` : `${value.length} selected`}{value?.some(id => !ids.includes(id)) ? " · Some selections are unavailable; reload or choose again." : ""}</p>
    {value?.length === 0 && <p role="alert" className="text-xs text-red-700">Select at least one location.</p>}
    {error && <p role="alert" className="text-xs text-red-700">{error} <button type="button" onClick={() => setAttempt(n => n + 1)}>Retry loading locations</button></p>}
  </fieldset>;
}
