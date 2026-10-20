"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type PilotOperation = {
  id: string; visitId: string; workOrderGuid: string; evidenceRevision: number;
  state: "preview" | "admitted" | "pending" | "partial" | "conflict" | "confirmed";
  acknowledged: boolean; observedAt: string | null;
  lines: { key: string; title: string; result: string; notes: string }[];
  warning?: string | null; recoveryAllowed: false;
};
export type PilotResponse = {
  enabled: boolean; canSend: boolean; evidenceRevision: number; workOrderGuid: string | null;
  warning?: string | null; labelEvidence?: unknown; operation: PilotOperation | null;
  candidates: { sheet: string; item: string; name: string; rating: string | null }[];
};
type RequestIds = { previewRequestId?: string; sendRequestId?: string };
const endpoint = "/api/shop-dispatch/inspection/pilot";
function valid(value: PilotResponse): boolean {
  if (typeof value?.enabled !== "boolean") return false;
  if (!value.enabled && !value.operation) return true;
  return Number.isInteger(value.evidenceRevision) && Array.isArray(value.candidates) &&
    (value.operation === null || (!!value.operation?.id && Array.isArray(value.operation.lines) &&
      ["preview", "admitted", "pending", "partial", "conflict", "confirmed"].includes(value.operation.state)));
}
export function usePilotInspection(visitId: string, shopId: number | undefined, evidenceRevision: number, blocked: boolean) {
  const [data, setData] = useState<PilotResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [admissionObserved, setAdmissionObserved] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [selected, setSelected] = useState<{ sheet: string; item: string }[]>([]);
  const active = useRef(false);
  const initialized = useRef(false);
  const edited = useRef(false);
  const ids = useRef<RequestIds>({});
  const selectionGeneration = useRef(0);
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const storageKey = `shop-dispatch:inspection-pilot:${shopId}:${visitId}:request-ids`;

  const resolvePreviewMarker = useCallback((operationId: string) => {
    if (ids.current.sendRequestId || ids.current.previewRequestId !== operationId) return;
    const next = { ...ids.current };
    delete next.previewRequestId;
    try {
      const serialized = JSON.stringify(next);
      sessionStorage.setItem(storageKey, serialized);
      if (sessionStorage.getItem(storageKey) !== serialized) throw new Error("Request IDs not retained");
      ids.current = next;
    } catch { setStorageError("Request ID storage is unavailable. Preview/send are disabled; status and reconciliation remain available."); }
  }, [storageKey]);

  const load = useCallback(async () => {
    if (active.current) return;
    active.current = true; setBusy(true); setError("");
    try {
      const response = await fetch(`${endpoint}?visitId=${encodeURIComponent(visitId)}`, { credentials: "include", cache: "no-store" });
      const value = await response.json() as PilotResponse & { error?: string };
      if (!response.ok || !valid(value)) throw new Error(value.error || "Synthetic pilot status is unavailable.");
      setData(value);
      if (value.operation && value.operation.state !== "preview") {
        setAdmissionObserved(true);
        setUncertain(false); setPreviewId(null); setAcknowledged(false);
      } else if (value.operation?.state === "preview" && !ids.current.sendRequestId &&
        (ids.current.previewRequestId ? value.operation.id === ids.current.previewRequestId : !edited.current)) {
        // Selection edits before this request do not invalidate its exact frozen receipt.
        // A different preview must never resolve an outstanding request identity.
        resolvePreviewMarker(value.operation.id);
        edited.current = false;
        setPreviewId(value.operation.id); setAcknowledged(false); setUncertain(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Synthetic pilot status is unavailable.");
    } finally { active.current = false; setBusy(false); setLoading(false); }
  }, [visitId, resolvePreviewMarker]);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Object.keys(parsed).some(key => !["previewRequestId", "sendRequestId"].includes(key) || typeof parsed[key] !== "string")) throw new Error("Invalid request IDs");
        ids.current = parsed;
        if (parsed.previewRequestId || parsed.sendRequestId) setUncertain(true);
      }
      // Check actual writable storage before allowing either explicit write.
      sessionStorage.setItem(storageKey, JSON.stringify(ids.current));
    } catch { setStorageError("Request ID storage is unavailable. Preview/send are disabled; status and reconciliation remain available."); }
    initialized.current = true;
    void load();
  }, [storageKey, load]);
  useEffect(() => {
    if (!initialized.current) return;
    setPreviewId(null); setAcknowledged(false);
    void load();
  }, [evidenceRevision, load]);
  useEffect(() => {
    if (blocked) { setPreviewId(null); setAcknowledged(false); edited.current = true; }
  }, [blocked]);

  function toggle(sheet: string, item: string) {
    if (active.current || uncertain || admissionObserved || (data?.operation && data.operation.state !== "preview") || ids.current.sendRequestId) return;
    edited.current = true; selectionGeneration.current++;
    setPreviewId(null); setAcknowledged(false);
    setSelected(previous => previous.some(entry => entry.sheet === sheet && entry.item === item)
      ? previous.filter(entry => entry.sheet !== sheet || entry.item !== item) : [...previous, { sheet, item }]);
  }
  async function write(action: "preview" | "send" | "reconcile") {
    if (active.current || !data) return;
    const admitted = admissionObserved || !!ids.current.sendRequestId || !!data.operation && data.operation.state !== "preview";
    if (action !== "reconcile" && (blockedRef.current || storageError || !data.enabled || !data.canSend || admitted || uncertain || error)) return;
    if (action === "preview" && (!selected.length || data.evidenceRevision !== evidenceRevision)) return;
    if (action === "send" && (!acknowledged || !previewId || previewId !== data.operation?.id || data.operation.state !== "preview" || data.operation.evidenceRevision !== data.evidenceRevision || data.evidenceRevision !== evidenceRevision)) return;
    if (action === "reconcile" && !admitted && !uncertain) return;
    active.current = true; setBusy(true); setError("");
    const generation = selectionGeneration.current;
    let dispatched = false;
    try {
      let body: object;
      if (action === "reconcile") body = { action, visitId };
      else {
        // The server identifies send by previewId; never persist an unused UUID.
        const requestId = action === "preview" ? crypto.randomUUID() : previewId!;
        const next = { ...ids.current, [action === "preview" ? "previewRequestId" : "sendRequestId"]: requestId };
        try {
          const serialized = JSON.stringify(next);
          sessionStorage.setItem(storageKey, serialized);
          if (sessionStorage.getItem(storageKey) !== serialized) throw new Error("Request ID not retained");
        } catch {
          setStorageError("Request ID storage failed. Nothing was sent. Preview/send are disabled; status and reconciliation remain available.");
          return;
        }
        ids.current = next;
        body = action === "preview"
          ? { action, visitId, requestId, evidenceRevision: data.evidenceRevision, selected }
          : { action, visitId, previewId, confirmed: true };
      }
      setAcknowledged(false); setPreviewId(null); setUncertain(true);
      dispatched = true;
      const response = await fetch(endpoint, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json() as PilotResponse & { error?: string };
      if (!response.ok || !valid(value) || !value.operation) throw new Error(value.error || "No complete pilot receipt was received.");
      setData(value);
      if (action === "preview" && value.operation.state === "preview" && value.operation.id === ids.current.previewRequestId &&
        !ids.current.sendRequestId && generation === selectionGeneration.current && !blockedRef.current) {
        edited.current = false; setPreviewId(value.operation.id); setUncertain(false);
        resolvePreviewMarker(value.operation.id);
      } else if (value.operation.state !== "preview") { setAdmissionObserved(true); setUncertain(false); }
    } catch (cause) {
      if (dispatched) setUncertain(true);
      setError(cause instanceof Error ? cause.message : "Pilot response was lost.");
    } finally { active.current = false; setBusy(false); }
  }
  return { data, loading, busy, error, storageError, uncertain, selected, previewId, acknowledged,
    admitted: admissionObserved || !!ids.current.sendRequestId || !!data?.operation && data.operation.state !== "preview",
    toggle, setAcknowledged, load, write };
}
