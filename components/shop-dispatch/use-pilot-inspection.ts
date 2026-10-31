"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type PublishedReportReference = { version: number; linkId: string };
export type PublishedReportOption = PublishedReportReference & { expiresAt: string };
export type PilotOperation = {
  id: string; visitId: string; workOrderGuid: string; evidenceRevision: number;
  state: "preview" | "admitted" | "pending" | "partial" | "conflict" | "confirmed";
  acknowledged: boolean; observedAt: string | null;
  lines: { key: string; title: string; result: string; notes: string }[];
  warning?: string | null; recoveryAllowed: false;
  publishedReport?: PublishedReportOption & {
    url: string; reportDigest: string; destination: "inspection-line-notes"; clickability: "unverified";
  };
};
export type PilotResponse = {
  enabled: boolean; canSend: boolean; evidenceRevision: number; workOrderGuid: string | null;
  warning?: string | null; labelEvidence?: unknown; operation: PilotOperation | null;
  candidates: { sheet: string; item: string; name: string; rating: string | null }[];
  reportOptions?: PublishedReportOption[];
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
  const [publishedReport, setPublishedReport] = useState<PublishedReportReference | null>(null);
  // An explicit preview-only retry replays these exact bytes, never current inputs.
  const previewBody = useRef<string | null>(null);
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
  function choosePublishedReport(reference: PublishedReportReference | null) {
    if (active.current || blockedRef.current || storageError || error || uncertain || admissionObserved ||
      !data?.enabled || !data.canSend || (data.operation && data.operation.state !== "preview") || ids.current.sendRequestId) return;
    if (reference && !data.reportOptions?.some(option => option.version === reference.version &&
      option.linkId === reference.linkId && Date.parse(option.expiresAt) > Date.now())) return;
    edited.current = true; selectionGeneration.current++;
    setPreviewId(null); setAcknowledged(false);
    setPublishedReport(reference ? { version: reference.version, linkId: reference.linkId } : null);
  }
  async function write(action: "preview" | "send" | "reconcile", retryPreview = false) {
    if (active.current || !data) return;
    const admitted = admissionObserved || !!ids.current.sendRequestId || !!data.operation && data.operation.state !== "preview";
    const exactRetry = retryPreview && action === "preview" && uncertain && !!ids.current.previewRequestId && !!previewBody.current;
    if (retryPreview && !exactRetry) return;
    if (action !== "reconcile" && (blockedRef.current || storageError || !data.enabled || !data.canSend || admitted || (!exactRetry && (uncertain || error)))) return;
    if (action === "preview" && !exactRetry && (!selected.length || data.evidenceRevision !== evidenceRevision)) return;
    if (action === "preview" && !exactRetry && publishedReport && !data.reportOptions?.some(option =>
      option.version === publishedReport.version && option.linkId === publishedReport.linkId && Date.parse(option.expiresAt) > Date.now())) {
      setError("Selected published report link is no longer active. Check pilot status and select an active link; no findings-only fallback was sent.");
      return;
    }
    if (action === "send" && (!acknowledged || !previewId || previewId !== data.operation?.id || data.operation.state !== "preview" || data.operation.evidenceRevision !== data.evidenceRevision || data.evidenceRevision !== evidenceRevision)) return;
    if (action === "reconcile" && !admitted && !uncertain) return;
    active.current = true; setBusy(true); setError("");
    const generation = selectionGeneration.current;
    let dispatched = false;
    try {
      let body: object;
      if (exactRetry) body = JSON.parse(previewBody.current!);
      else if (action === "reconcile") body = { action, visitId };
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
          ? { action, visitId, requestId, evidenceRevision: data.evidenceRevision, selected,
            ...(publishedReport ? { publishedReport } : {}) }
          : { action, visitId, previewId, confirmed: true };
      }
      const serializedBody = exactRetry ? previewBody.current! : JSON.stringify(body);
      if (action === "preview") previewBody.current = serializedBody;
      setAcknowledged(false); setPreviewId(null); setUncertain(true);
      dispatched = true;
      const response = await fetch(endpoint, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: serializedBody });
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
  return { data, loading, busy, error, storageError, uncertain, selected, previewId, acknowledged, publishedReport,
    canRetryPreview: uncertain && !!ids.current.previewRequestId && !!previewBody.current && !ids.current.sendRequestId,
    admitted: admissionObserved || !!ids.current.sendRequestId || !!data?.operation && data.operation.state !== "preview",
    toggle, choosePublishedReport, setAcknowledged, load, write };
}
