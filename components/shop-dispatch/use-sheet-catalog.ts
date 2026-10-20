"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { StaffSheet } from "@/lib/auto-dvi/staff/model";

export type SheetSnapshot = {
  scope: "shop" | "enterprise"; scopeLabel: string; canManage: boolean; revision: number;
  sheets: StaffSheet[]; archivedSheetIds: string[]; defaultSheet: string;
  templates: StaffSheet[]; inspectionEnabled: boolean;
};
export type SheetCommand =
  | { type: "save"; sheet: StaffSheet; makeDefault: boolean }
  | { type: "default"; sheet: string }
  | { type: "archive"; sheetId: string; archived: boolean };
export type SheetRequest = { requestId: string; revision: number; command: SheetCommand };
const endpoint = "/api/shop-dispatch/inspection/sheets";
function validSnapshot(value: SheetSnapshot): boolean {
  return !!value && ["shop", "enterprise"].includes(value.scope) && typeof value.scopeLabel === "string" &&
    typeof value.canManage === "boolean" && Number.isInteger(value.revision) && Array.isArray(value.sheets) &&
    Array.isArray(value.templates) && Array.isArray(value.archivedSheetIds) &&
    typeof value.defaultSheet === "string" && typeof value.inspectionEnabled === "boolean";
}
export function useSheetCatalog(enabled = true) {
  const [data, setData] = useState<SheetSnapshot | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<SheetRequest | null>(null);
  const [conflict, setConflict] = useState(false);
  const sending = useRef(false);
  const pendingRef = useRef<SheetRequest | null>(null);
  const conflictRef = useRef(false);
  const deniedRef = useRef(false);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(endpoint, { credentials: "include", cache: "no-store" });
      if (response.status === 403) {
        deniedRef.current = true;
        if (mounted.current) { setForbidden(true); setData(null); setError(""); }
        return null;
      }
      const value = await response.json();
      if (!response.ok || !validSnapshot(value)) throw new Error(value?.error || "Inspection sheets could not be loaded.");
      deniedRef.current = false;
      if (mounted.current) { setData(value); setForbidden(false); setError(""); }
      return value as SheetSnapshot;
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Inspection sheets could not be loaded.");
      return null;
    } finally { if (mounted.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (enabled) void load();
    return () => { mounted.current = false; };
  }, [enabled, load]);
  async function send(request: SheetRequest) {
    if (sending.current) return null;
    sending.current = true; setBusy(true); setError(""); setNotice("");
    pendingRef.current = request; setPending(request);
    try {
      const response = await fetch(endpoint, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      // A malformed response, timeout or 5xx cannot prove whether a write committed.
      const value = await response.json();
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          pendingRef.current = null; setPending(null);
          if (response.status === 409) { conflictRef.current = true; setConflict(true); }
        }
        throw new Error(typeof value?.error === "string" ? value.error : `Save not confirmed (${response.status}). Your draft is retained.`);
      }
      if (response.status === 202 || !validSnapshot(value)) throw new Error("No complete save receipt received. Retry the exact request.");
      pendingRef.current = null; setPending(null); setData(value);
      setNotice("Saved. Approved versions and existing inspection results are retained.");
      return value as SheetSnapshot;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save outcome unknown. Retry the exact request.");
      return null;
    } finally { sending.current = false; setBusy(false); }
  }
  async function command(command: SheetCommand) {
    if (!data?.canManage || pendingRef.current || sending.current || conflictRef.current) return null;
    return send({ requestId: crypto.randomUUID(), revision: data.revision, command: structuredClone(command) });
  }
  async function discardAndReload() {
    if (pendingRef.current || sending.current) return false;
    sending.current = true;
    try {
      const value = await load();
      if (!value && !deniedRef.current) return false;
      conflictRef.current = false; setConflict(false); setNotice(value ? "Latest catalog loaded. The local draft was explicitly discarded." : "DVI access is no longer available. The local draft was explicitly discarded.");
      return true;
    } finally { sending.current = false; }
  }
  return { data, forbidden, loading, busy, error, notice, pending, conflict, command,
    reload: () => pendingRef.current || sending.current || conflictRef.current ? Promise.resolve(null) : load(),
    discardAndReload, retry: () => pendingRef.current ? send(pendingRef.current) : Promise.resolve(null) };
}
export type SheetCatalog = ReturnType<typeof useSheetCatalog>;
