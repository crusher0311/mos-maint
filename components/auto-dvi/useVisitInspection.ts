"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryEntry, Sheet, Visit } from "@/lib/auto-dvi/visit-model";

export type VisitPayload = {
  ok: true;
  record: { revision: number; visits: Visit[] };
  history: HistoryEntry[];
  templates: Sheet[];
  templateRevision: number;
  canManageSheets?: boolean;
  sharingReason?: string;
};

export class VisitRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

// This resource has no existing generated client. All calls are same-origin,
// cookie-authenticated and restricted to the visit API (never provider writes).
export function useVisitInspection(vin: string) {
  const [data, setData] = useState<VisitPayload | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const mutationLock = useRef(false);
  const scope = useRef(vin);
  scope.current = vin;

  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    // Hide previously shared findings until authorization is revalidated.
    setHistory([]);
    try {
      const response = await fetch(`/api/auto-dvi/visits?vin=${encodeURIComponent(vin)}`, { credentials: "include", cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new VisitRequestError(payload.error || "Could not load inspection visits.", response.status);
      if (!mounted.current || request !== sequence.current || scope.current !== vin) return null;
      setData(payload);
      setHistory(payload.history || []);
      setAuthorized(true);
      setError("");
      return payload as VisitPayload;
    } catch (cause) {
      if (!mounted.current || request !== sequence.current || scope.current !== vin) return null;
      setAuthorized(false);
      setHistory([]);
      if (cause instanceof VisitRequestError && [401, 403].includes(cause.status)) setData(null);
      setError(cause instanceof Error ? cause.message : "Could not load inspection visits.");
      return null;
    } finally {
      if (mounted.current && request === sequence.current) setLoading(false);
    }
  }, [vin]);

  useEffect(() => {
    mounted.current = true;
    setData(null); setHistory([]); setLoading(true); setAuthorized(false);
    void refresh();
    const focus = () => { if (document.visibilityState === "visible" && !mutationLock.current) void refresh(); };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const timer = window.setInterval(focus, 30000);
    return () => {
      mounted.current = false; ++sequence.current;
      clearInterval(timer); window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [refresh]);

  const write = async (body: Record<string, unknown> | FormData) => {
    if (mutationLock.current) throw new Error("Another inspection action is still running.");
    mutationLock.current = true; setBusy(true); setError("");
    try {
      const upload = body instanceof FormData;
      const response = await fetch(upload ? "/api/auto-dvi/visit-media" : "/api/auto-dvi/visits", {
        method: "POST", credentials: "include",
        ...(upload ? {} : { headers: { "Content-Type": "application/json" } }),
        body: upload ? body : JSON.stringify({ vin, ...body }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        if (response.status === 409) {
          await refresh();
          throw new VisitRequestError("This record changed elsewhere. Your unsaved entry is preserved. Compare the latest record before saving again.", 409);
        }
        if ([401, 403].includes(response.status)) { setHistory([]); setData(null); setAuthorized(false); }
        throw new VisitRequestError(payload.error || "Could not save. Your entry has not been discarded.", response.status);
      }
      // Persisted mutation succeeded even if its follow-up refresh fails.
      if (mounted.current && scope.current === vin && payload.record) {
        setData(previous => previous ? { ...previous, ...payload, history: [] } : payload);
      }
      await refresh();
    } finally {
      mutationLock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { data, history, loading, busy, error, authorized, refresh, write };
}
