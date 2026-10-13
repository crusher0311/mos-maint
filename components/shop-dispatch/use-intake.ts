"use client";
import { useEffect, useRef, useState } from "react";
import type { Board } from "@/lib/shop-dispatch/model";
import { intakeRequestSchema } from "@/lib/shop-dispatch/intake-types";

type Pending = { body: string; scope: string };
const requestKey = (shopId: number) => `shop-dispatch:intake:${shopId}:pending`;
const receiptKey = (shopId: number, scope: string) => `shop-dispatch:intake:${shopId}:receipt:${scope}`;
export function useIntake(shopId: number | undefined, scope: string, refresh?: () => Promise<void>) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<Board | null>(null);
  const [savedScope, setSavedScope] = useState("");
  const [savedAction, setSavedAction] = useState("");
  const [savedRequestId,setSavedRequestId]=useState("");
  const sending = useRef(false);
  useEffect(() => {
    try {
      if (shopId === undefined) throw new Error("Shop identity is unavailable. Intake saves are disabled.");
      const raw = sessionStorage.getItem(requestKey(shopId));
      if (raw) {
        const value = JSON.parse(raw) as Pending;
        intakeRequestSchema.parse(JSON.parse(value.body));
        if (typeof value.scope !== "string") throw new Error("Invalid saved request");
        setPending(value);
      }
      setReady(true);
    } catch { setError("Cannot safely recover session storage. Intake is disabled; do not start a new request if a previous outcome is unknown."); }
  }, [shopId]);
  async function send(payload?: unknown): Promise<Board | null> {
    if (sending.current || !ready || shopId === undefined) return null;
    let request: Pending;
    try {
      // Re-read the shared shop lock: another intake surface may own a request.
      const raw = sessionStorage.getItem(requestKey(shopId));
      const existing = raw ? JSON.parse(raw) as Pending : null;
      if (existing && payload) { setPending(existing); throw new Error("Resolve the saved intake request first. Retry preserves its original identity and revision."); }
      request = existing ?? { body: JSON.stringify(intakeRequestSchema.parse(payload)), scope };
      intakeRequestSchema.parse(JSON.parse(request.body));
      sessionStorage.setItem(requestKey(shopId), JSON.stringify(request));
      setPending(request);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Session storage unavailable. Nothing was sent."); return null; }
    sending.current = true; setBusy(true); setError(""); setNotice("");
    let confirmed = false;
    try {
      const response = await fetch("/api/shop-dispatch/intake", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: request.body });
      if (!response.ok) {
        let detail = ""; try { const data = await response.json(); detail = typeof data.error === "string" ? data.error : ""; } catch { /* retain HTTP status */ }
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          sessionStorage.removeItem(requestKey(shopId)); setPending(null);
        }
        throw new Error(`Intake not confirmed (${response.status}). ${detail || "Your draft is preserved."}${response.status === 409 ? " Refresh the board, then explicitly review the latest revision before resubmitting." : ""}`);
      }
      const data = await response.json() as { board: Board };
      if (!data.board || !Number.isInteger(data.board.revision) || !Array.isArray(data.board.visits)) throw new Error("Incomplete response. Retry the identical request; do not create another.");
      const submitted=JSON.parse(request.body);
      const action = submitted.action as string;
      const visitId=action==="checkIn"?data.board.visits.find(v=>submitted.appointmentId?v.intake?.appointmentId===submitted.appointmentId:v.intake?.requestId===submitted.requestId)?.id:submitted.visitId;
      // Persist the confirmed outcome before releasing the shop-wide request lock.
      // A reload must not turn a successful check-in into another walk-in.
      sessionStorage.setItem(receiptKey(shopId, request.scope), JSON.stringify({ action, revision: data.board.revision,visitId }));
      setSavedRequestId(submitted.requestId??"");
      confirmed = true; setSaved(data.board); setSavedScope(request.scope); setSavedAction(action);
      sessionStorage.removeItem(requestKey(shopId)); setPending(null);
      setNotice("Server response received. Review the visit and ticket status below.");
      try { await refresh?.(); } catch { setError("Saved, but board refresh failed. Refresh the board manually."); }
      return data.board;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Outcome unknown. Retry the identical request.");
      if (!confirmed) {
        try { const raw = sessionStorage.getItem(requestKey(shopId)); setPending(raw ? JSON.parse(raw) : null); } catch { setReady(false); }
      }
      return null;
    } finally { sending.current = false; setBusy(false); }
  }
  function clearReceipt() {
    if (sending.current || pending) return;
    try {
      if (shopId === undefined) return;
      sessionStorage.removeItem(receiptKey(shopId, scope));
    } catch { setError("Cannot clear the previous receipt safely. Keep the recorded visit and retry later."); return; }
    setSaved(null); setSavedScope(""); setSavedAction(""); setNotice(""); setError("");
    return true;
  }
  return { ready, busy, pending, error, notice, saved, savedScope, savedAction, savedRequestId,send, clearReceipt };
}
