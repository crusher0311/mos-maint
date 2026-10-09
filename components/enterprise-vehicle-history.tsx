"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, LockKeyhole, RefreshCw } from "lucide-react";

export type VehicleHistoryResponse = {
  enabled: boolean;
  vin: string | null;
  currentShopId: number;
  policyRevision: string;
  checkedAt: string;
  reason?: string;
  locations: {
    shopId: number; name: string; state: "available" | "incomplete" | "unavailable";
    reason?: string; hasMore: boolean; fetchedAt: string | null;
  }[];
  events: {
    id: string; shopId: number; location: string; provider: string;
    workOrderId: string | null; jobId: string; title: string; date: string | null;
    mileage: number | null; mileageUnit: "miles" | "kilometers" | null;
    status: "completed" | "declined" | "unknown"; origin: string; readOnly: true;
    resolution?: {
      state: "outstanding" | "partial" | "completed_elsewhere";
      completedBy: string[]; remainingComponents: string[];
    };
  }[];
};

function dateLabel(value: string | null, time = false) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return time ? date.toLocaleString() : date.toLocaleDateString();
}

/** Intentionally independent of plan/query caches and persistent browser storage. */
export default function EnterpriseVehicleHistory({ vin, currentShopId }: { vin: string; currentShopId: number }) {
  const normalizedVin = vin.trim().toUpperCase();
  const identity = `${currentShopId}:${normalizedVin}`;
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const [result, setResult] = useState<{ identity: string; data: VehicleHistoryResponse } | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "completed" | "declined">("all");
  const data = result?.identity === identity ? result.data : null;

  const refresh = useCallback(async () => {
    const sequence = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    // Clear evidence even on same-context refresh: failures must never retain old rows.
    setResult(null);
    setFailure(null);
    setLoading(true);
    const timeout = setTimeout(() => request.abort(), 20000);
    try {
      if (!normalizedVin || !Number.isFinite(currentShopId)) throw new Error("Missing vehicle context");
      const response = await fetch(`/api/vehicle-history?vin=${encodeURIComponent(normalizedVin)}`, {
        credentials: "include", cache: "no-store", signal: request.signal,
      });
      if (!response.ok) throw new Error("History request failed");
      const payload: VehicleHistoryResponse = await response.json();
      if (payload.currentShopId !== currentShopId ||
          (payload.vin !== normalizedVin && !(payload.enabled === false && payload.vin === null)) ||
          typeof payload.enabled !== "boolean" || !Array.isArray(payload.locations) || !Array.isArray(payload.events) ||
          payload.events.some(event => event.readOnly !== true)) throw new Error("History context did not match");
      if (sequence === generation.current && activeIdentity.current === identity) setResult({ identity, data: payload });
    } catch {
      if (sequence === generation.current && activeIdentity.current === identity) {
        setResult(null);
        setFailure("Vehicle history is unavailable. Coverage could not be verified; this does not mean no work exists.");
      }
    } finally {
      clearTimeout(timeout);
      if (sequence === generation.current && activeIdentity.current === identity) setLoading(false);
    }
  }, [identity, normalizedVin, currentShopId]);

  useEffect(() => {
    setFilter("all");
    void refresh();
    const onVisible = () => { if (document.visibilityState !== "hidden") void refresh(); };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        generation.current++;
        controller.current?.abort();
        setResult(null);
      } else onVisible();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = setInterval(onVisible, 30000);
    return () => {
      generation.current++;
      controller.current?.abort();
      clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const events = data?.events.filter(event => filter === "all" || event.status === filter) ?? [];
  const incomplete = data?.locations.some(location => location.state !== "available" || location.hasMore);

  return (
    <section aria-label="Enterprise vehicle history" className="my-6 rounded-xl border border-gray-200 bg-white shadow-sm print:hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-100 p-5">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900"><Building2 className="h-5 w-5 text-gray-500" />Enterprise vehicle history</h2>
          <p className="mt-1 text-sm text-gray-500">Evidence from participating locations, separate from this repair order.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"><RefreshCw className="h-4 w-4" />{loading ? "Checking…" : "Refresh history"}</button>
      </div>
      <div className="space-y-4 p-5">
        <p className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />Read-only evidence. Other locations’ jobs cannot be added, edited, or resolved here. Your existing RO actions are unchanged.</p>
        <div aria-live="polite" aria-busy={loading}>
          {loading ? <div className="space-y-3" role="status"><p className="text-sm text-gray-500">Checking vehicle evidence and location coverage…</p><div className="h-12 rounded-lg bg-gray-100" /><div className="h-16 rounded-lg bg-gray-100" /></div> : failure ? <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{failure} Use Refresh history to retry.</p> : data && !data.enabled ? <div className="rounded-lg border border-gray-200 bg-gray-50 p-4"><p className="font-medium text-gray-800">Vehicle history sharing is off</p><p className="mt-1 text-sm text-gray-500">{data.reason || "An owner or admin must explicitly enable sharing for authorized locations."}</p></div> : data ? <>
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-gray-800">{incomplete ? "Partial location coverage" : data.locations.length ? "Location coverage" : "No location coverage"}</h3>
              <p className="mt-1 text-xs text-gray-500">Checked {dateLabel(data.checkedAt, true)} · Policy {data.policyRevision}</p>
              {data.reason && <p className="mt-2 text-sm text-amber-800">{data.reason}</p>}
              <ul className="mt-3 divide-y divide-gray-100 rounded-lg border border-gray-200">
                {data.locations.map(location => <li key={location.shopId} className="p-3 text-sm">
                  <div className="flex flex-wrap justify-between gap-2"><span className="font-medium text-gray-800">{location.name}{location.shopId === currentShopId ? " · Current shop" : ""}</span><span className={location.state === "available" && !location.hasMore ? "text-green-700" : "text-amber-700"}>{location.state === "available" ? "Available" : location.state === "incomplete" ? "Incomplete" : "Unavailable"}{location.hasMore ? " · More records not shown" : ""}</span></div>
                  <p className="mt-1 text-xs text-gray-500">{location.reason ? `${location.reason} · ` : ""}{location.fetchedAt ? `Fetched ${dateLabel(location.fetchedAt, true)}` : "No fetch verified"}</p>
                </li>)}
              </ul>
              {!data.locations.length && <p className="mt-2 text-sm text-amber-800">No locations were verified. This is not evidence of an empty service history.</p>}
            </div>
            <div className="mb-3 flex flex-wrap gap-2" aria-label="Filter vehicle evidence">{(["all", "completed", "declined"] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={`rounded-lg border px-3 py-1.5 text-sm ${filter === value ? "border-blue-200 bg-blue-50 text-blue-800" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>{value === "all" ? "All evidence" : value === "completed" ? "Performed" : "Deferred / declined"}</button>)}</div>
            {!events.length ? <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">{incomplete || !data.locations.length ? "No matching evidence returned from the verified coverage. Other work may exist." : "No matching records returned from the locations shown above. This is not a complete lifetime service history."}</p> : <ul className="divide-y divide-gray-100">
              {events.map(event => <li key={`${event.shopId}:${event.id}`} className="py-4">
                <div className="flex flex-wrap justify-between gap-2"><h4 className="font-medium text-gray-900">{event.title}</h4><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${event.status === "completed" ? "bg-green-50 text-green-800" : event.status === "declined" ? "bg-amber-50 text-amber-800" : "bg-gray-100 text-gray-600"}`}>{event.status === "completed" ? "Performed" : event.status === "declined" ? "Deferred / declined" : "Status unknown"}</span></div>
                <p className="mt-2 text-sm text-gray-600">{event.location} · {event.provider} · {dateLabel(event.date)} · {event.mileage === null ? "Mileage unavailable" : `${event.mileage.toLocaleString()} ${event.mileageUnit === "kilometers" ? "km" : event.mileageUnit === "miles" ? "mi" : "(unit unknown)"}`}</p>
                <p className="mt-1 break-words text-xs text-gray-500">Source: {event.origin} · {event.workOrderId ? `RO ${event.workOrderId}` : "RO unavailable"} · Job {event.jobId} · Read-only</p>
                {event.resolution && <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700"><p className="font-medium">{event.resolution.state === "completed_elsewhere" ? "Completed elsewhere" : event.resolution.state === "partial" ? "Partially completed elsewhere" : "Outstanding"}</p>{event.resolution.completedBy.length > 0 && <p className="mt-1">Completion evidence: {event.resolution.completedBy.join(", ")}</p>}{event.resolution.remainingComponents.length > 0 && <p className="mt-1">Remaining: {event.resolution.remainingComponents.join(", ")}</p>}<p className="mt-1 text-xs text-gray-500">Evidence only; the original job and this RO have not been changed.</p></div>}
              </li>)}
            </ul>}
          </> : null}
        </div>
      </div>
    </section>
  );
}
