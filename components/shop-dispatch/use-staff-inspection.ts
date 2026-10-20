"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StaffCommand, StaffInspection, StaffSheet } from "@/lib/auto-dvi/staff/model";
import type { WorkflowInspection } from "@/lib/auto-dvi/workflow-binding-contract";

export type InspectionRequest = { visitId: string; requestId: string; revision: number; command: StaffCommand | { type: "initialize"; boardRevision: number } };
type BindingRecovery = { requestId: string; expectedBoardRevision: number; expectedInspectionRevision: number; workflowVisitId: string };
export type InspectionResponse = {
  enabled: boolean; record: WorkflowInspection | null; inspection: StaffInspection | null;
  catalog: StaffSheet[]; canEdit: boolean; canReview: boolean; boardRevision: number;
  bindingRequest?: BindingRecovery | null; error?: string;
};
type Pending = { kind: "command"; body: InspectionRequest } | {
  kind: "photo"; visitId: string; requestId: string; revision: number; sheet: string; item: string;
  provenance: "camera" | "upload"; name: string; hash: string;
};
const endpoint = "/api/shop-dispatch/inspection";
function recoveryRequest(visitId: string, binding: BindingRecovery): InspectionRequest {
  return { visitId, requestId: binding.requestId, revision: 0, command: { type: "initialize", boardRevision: binding.expectedBoardRevision } };
}
function validResponse(data: InspectionResponse): boolean {
  return typeof data?.enabled === "boolean" && Array.isArray(data.catalog) &&
    Number.isInteger(data.boardRevision) && (data.inspection === null || Number.isInteger(data.inspection?.revision));
}
async function fileHash(file: File) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), v => v.toString(16).padStart(2, "0")).join("");
}
export function useStaffInspection(visitId: string, _shopId?: number) {
  const [data, setData] = useState<InspectionResponse | null>(null);
  const [latest, setLatest] = useState<InspectionResponse | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const sending = useRef(false);
  const fileRef = useRef<File | null>(null);
  const load = useCallback(async (compare = false) => {
    try {
      const response = await fetch(`${endpoint}?visitId=${encodeURIComponent(visitId)}`, { credentials: "include", cache: "no-store" });
      const value = await response.json() as InspectionResponse;
      if (!response.ok || !validResponse(value)) throw new Error(value.error || "Inspection could not be loaded.");
      if (compare) setLatest(value); else { setData(value); setError(""); }
      if (value.bindingRequest) {
        const recovered: Pending = { kind: "command", body: recoveryRequest(visitId, value.bindingRequest) };
        setPending(recovered);
      }
      return value;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Inspection could not be loaded.");
      return null;
    } finally { setLoading(false); }
  }, [visitId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function send(request: Pending, retryFile?: File): Promise<InspectionResponse | null> {
    if (sending.current) return null;
    sending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      // Hold the exact identity and payload in memory for explicit acknowledgment retries.
      setPending(request);
      let body: string | FormData;
      if (request.kind === "photo") {
        const file = retryFile ?? fileRef.current;
        if (!file || await fileHash(file) !== request.hash) throw new Error("Reselect the original photo below to retry this exact upload. No new request was sent.");
        fileRef.current = file;
        body = new FormData();
        for (const field of ["visitId", "sheet", "item", "revision", "requestId", "provenance"] as const) body.set(field, String(request[field]));
        body.set("file", file, request.name);
      } else body = JSON.stringify(request.body);
      const response = await fetch(request.kind === "photo" ? `${endpoint}/media` : endpoint, {
        method: "POST", credentials: "include", body,
        ...(typeof body === "string" ? { headers: { "Content-Type": "application/json" } } : {}),
      });
      const value = await response.json() as InspectionResponse;
      if (value.bindingRequest) {
        const recovered: Pending = { kind: "command", body: recoveryRequest(visitId, value.bindingRequest) };
        setPending(recovered);
        throw new Error(value.error || "Local binding acknowledgment is pending. Retry the exact request.");
      }
      if (!response.ok) {
        // Only explicit, parsed 4xx rejection is definitive; malformed replies and 5xx remain ambiguous.
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          setPending(null); fileRef.current = null;
          if (response.status === 409) { setConflict(true); await load(true); }
        }
        throw new Error(value.error || `Save not confirmed (${response.status}). Your draft is preserved.`);
      }
      if (response.status === 202 || !validResponse(value) || !value.inspection) throw new Error("No complete save receipt received. Retry the same request; do not create another.");
      setPending(null); fileRef.current = null;
      setData(value); setNotice(request.kind === "photo" ? "Photo saved — server receipt received." : "Saved — server receipt received.");
      return value;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Outcome unknown. Retry the identical request.");
      return null;
    } finally { sending.current = false; setBusy(false); }
  }
  async function command(command: InspectionRequest["command"]) {
    if (!data || pending || conflict || sending.current) return null;
    // Starting has no item draft to rebase. Read current availability and board
    // revision after ticket creation; never replay a pending binding or POST.
    if (command.type === "initialize") {
      sending.current = true; setBusy(true);
      const current = await load();
      sending.current = false; setBusy(false);
      if (!current || current.bindingRequest || !current.enabled || !current.canEdit || current.record?.closed || !current.catalog.length) return null;
      if (current.inspection) return current;
      return send({ kind: "command", body: { visitId, requestId: crypto.randomUUID(), revision: 0, command: { type: "initialize", boardRevision: current.boardRevision } } });
    }
    return send({ kind: "command", body: { visitId, requestId: crypto.randomUUID(), revision: data.inspection?.revision ?? 0, command } });
  }
  async function upload(sheet: string, item: string, file: File, provenance: "camera" | "upload") {
    if (!data || pending || conflict || sending.current) return null;
    // Lock before hashing so two file inputs cannot initiate concurrent requests.
    sending.current = true; setBusy(true);
    try {
      const hash = await fileHash(file);
      fileRef.current = file;
      const request: Pending = { kind: "photo", visitId, requestId: crypto.randomUUID(), revision: data.inspection?.revision ?? 0, sheet, item, provenance, name: file.name, hash };
      sending.current = false;
      return await send(request);
    } catch { setError("Photo could not be prepared. Nothing was uploaded."); return null; }
    finally { sending.current = false; setBusy(false); }
  }
  async function discardAndReload() {
    if (pending || sending.current) return false;
    const value = await load(true);
    if (!value || value.bindingRequest) return false;
    setData(value); setLatest(null); setConflict(false); setError(""); setNotice("Latest server values loaded. Local drafts discarded.");
    return true;
  }
  return { data, latest, pending, loading, busy, error, notice, conflict, command, upload,
    retry: (file?: File) => pending ? send(pending, file) : Promise.resolve(null),
    compare: () => load(true), reload: () => load(), discardAndReload };
}
