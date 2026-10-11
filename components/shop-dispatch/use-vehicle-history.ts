"use client";
import { useEffect, useRef, useState } from "react";
import type { HistoryCoverage, HistoryEvent } from "@/lib/vehicle-history/model";
import type { HistoryEntry, VisitRecord } from "@/lib/auto-dvi/visit-model";
import type { InspectionResultsDoc } from "@/lib/data/repositories/auto-dvi";

export interface DispatchVehicleHistory {
  visitId: string; vin: string | null; currentShopId: number;
  events: HistoryEvent[]; locations: HistoryCoverage[]; checkedAt: string;
  sharing: { enabled: boolean; reason?: string }; reason?: string;
}
export interface DviHistory {
  ok: boolean; record: VisitRecord; history: HistoryEntry[]; sharingReason?: string;
}
export interface DviSnapshot {
  ok: boolean; results: (Omit<InspectionResultsDoc, "updatedAt"> & { updatedAt: string }) | null;
}

/** Isolated read-only requests: never touch dispatch/scheduling caches or drafts. */
export function useHistoryRead<T>(identity: string, url: string, enabled: boolean, validate: (value: T) => boolean) {
  const [result, setResult] = useState<{ identity: string; data: T } | null>(null);
  const [failure, setFailure] = useState<{ identity: string; text: string; forbidden: boolean } | null>(null);
  const [settled, setSettled] = useState("");
  const [attempt, setAttempt] = useState(0);
  const active = useRef(identity); active.current = identity;
  const validator = useRef(validate); validator.current = validate;
  const generation = useRef(0);
  useEffect(() => {
    const sequence = ++generation.current;
    if (!enabled) return;
    const controller = new AbortController();
    setResult(null); setFailure(null); setSettled("");
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    const current = () => sequence === generation.current && active.current === identity;
    void (async () => {
      try {
        const response = await fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          if (current()) setFailure({ identity, forbidden: response.status === 403, text: response.status === 403 ? "History is unavailable for your current access. No permission changes were made." : "History could not be checked. This does not mean no records exist." });
          return;
        }
        const data: T = await response.json();
        if (!validator.current(data)) throw new Error("History context mismatch");
        if (current()) setResult({ identity, data });
      } catch {
        if (current()) setFailure({ identity, forbidden: false, text: "History could not be checked. This does not mean no records exist." });
      } finally {
        window.clearTimeout(timeout);
        if (current()) setSettled(identity);
      }
    })();
    return () => { generation.current++; controller.abort(); window.clearTimeout(timeout); };
  }, [identity, url, enabled, attempt]);
  return {
    data: enabled && result?.identity === identity ? result.data : null,
    failure: enabled && failure?.identity === identity ? failure : null,
    loading: enabled && settled !== identity,
    retry: () => { setResult(null); setFailure(null); setSettled(""); setAttempt(value => value + 1); },
  };
}
