"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CustomerReport, ReleaseBranding, ReleaseConcern, ReleaseSelection } from "@/lib/auto-dvi/release/model";
import { customerReport, pendingRelease, releaseBranding } from "./release-contract";

export type ReleaseAuthority = {
  enabled: boolean; canPublish: boolean;
  current: { version: number; report: CustomerReport } | null;
  concerns: ReleaseConcern[]; branding: ReleaseBranding;
  links: { id: string; expiresAt: string; revokedAt: string | null }[];
};
export type ReleasePreview = {
  previewId: string; digest: string; report: CustomerReport;
  current: CustomerReport | null; excludedHazards: { key: string; title: string }[];
};
type Pending =
  | { visitId: string; type: "preview"; selection: ReleaseSelection }
  | { visitId: string; type: "publish"; requestId: string; previewId: string; digest: string; acknowledgeExcludedHazards: boolean }
  | { visitId: string; type: "link"; requestId: string; action: "create" | "extend" | "revoke" | "replace" | "copy"; linkId?: string; expiresAt?: string };
type LinkReceipt = { id: string; token?: string; expiresAt: string; revokedAt?: string | null };
const endpoint = "/api/shop-dispatch/inspection/release";

export function useInspectionRelease(visitId: string, shopId?: number) {
  const storageKey = `workflow-release:${shopId ?? "session-shop"}:${visitId}`;
  const [authority, setAuthority] = useState<ReleaseAuthority | null>(null);
  const [preview, setPreview] = useState<ReleasePreview | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [link, setLink] = useState<LinkReceipt | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const sending = useRef(false);
  const ready = useRef(false);
  const pendingRef = useRef<Pending | null>(null);
  const reload = useCallback(async () => {
    try {
      const response = await fetch(`${endpoint}?${new URLSearchParams({ visitId })}`, { credentials: "include", cache: "no-store" });
      const data = await response.json() as ReleaseAuthority;
      if (!response.ok || typeof data.enabled !== "boolean" || typeof data.canPublish !== "boolean") throw new Error();
      // Authorized advisors can still inspect existing releases with the gate off.
      if (data.canPublish && (!Array.isArray(data.links) || !Array.isArray(data.concerns) || !releaseBranding.safeParse(data.branding).success || (data.current !== null && (!Number.isInteger(data.current?.version) || !customerReport.safeParse(data.current?.report).success)))) throw new Error();
      setAuthority(data);
    } catch { setAuthority(null); setError("Release permissions and saved releases could not be loaded. Retry to check availability."); }
    finally { setLoading(false); }
  }, [visitId]);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const request = pendingRelease.parse(JSON.parse(saved)) as Pending;
        if (request.visitId !== visitId || !["preview", "publish", "link"].includes(request.type)) throw new Error();
        pendingRef.current = request; setPending(request);
      }
      ready.current = true;
      setStorageReady(true);
    } catch { setError("Pending-request storage is unavailable or unreadable. Release actions are blocked to protect retry identity."); }
    void reload();
  }, [storageKey, visitId, reload]);
  useEffect(() => {
    if (!pending && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending, busy]);
  async function send(request: Pending, retry = false) {
    const allowedWithGateOff = request.type === "link" && (request.action === "revoke" || request.action === "copy");
    if (!ready.current || sending.current || (pendingRef.current && !retry) || !authority?.canPublish || (!authority.enabled && !allowedWithGateOff)) return;
    // Persist the exact body before the first network attempt. Never persist link tokens.
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setError("Cannot retain the request safely in this browser. No request was sent."); return; }
    pendingRef.current = request; setPending(request);
    sending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      const value = await response.json();
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
          sessionStorage.removeItem(storageKey); pendingRef.current = null; setPending(null); setPreview(null);
          await reload();
          throw new Error("The server rejected this request. Review current evidence and permissions, then create a new preview.");
        }
        throw new Error("The outcome is unconfirmed. Retry the retained request; do not create a replacement.");
      }
      if (response.status === 202) throw new Error("No final receipt received. Retry the retained request.");
      if (request.type === "preview") {
        if (!value.previewId || !value.digest || !customerReport.safeParse(value.report).success || (value.current !== null && !customerReport.safeParse(value.current).success) || !Array.isArray(value.excludedHazards)) throw new Error("Preview receipt is incomplete. Retry the retained request.");
        setPreview(value as ReleasePreview);
        setNotice("Preview prepared. Nothing has been published or sent.");
      } else if (request.type === "publish") {
        if (!Number.isInteger(value.version) || !customerReport.safeParse(value.report).success || (value.link !== null && (!value.link?.id || !value.link?.token || !value.link?.expiresAt))) throw new Error("Publication receipt is incomplete. Retry the retained request.");
        setPreview(null); setLink(value.link ?? null);
        setNotice(`Version ${value.version} published. This does not mean it was sent to the customer.`);
      } else {
        if (!value.link?.id || !value.link.expiresAt || (["create", "replace", "copy"].includes(request.action) && !value.link.token)) throw new Error("Link receipt is incomplete. Retry the retained request.");
        setLink(value.link as LinkReceipt);
        setNotice(request.action === "copy" ? "Existing link retrieved. It has not been sent or delivered." : "Link change confirmed. No customer delivery was performed.");
      }
      sessionStorage.removeItem(storageKey); pendingRef.current = null; setPending(null);
      await reload();
      return request.type === "link" ? value.link as LinkReceipt : null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Outcome unknown. Retry the retained request."); }
    finally { sending.current = false; setBusy(false); }
  }
  return {
    authority, preview, pending, loading, busy, error, notice, link, reload, storageReady,
    invalidate: () => setPreview(null),
    prepare: (selection: ReleaseSelection) => send({ visitId, type: "preview", selection }),
    publish: (acknowledgeExcludedHazards: boolean) => preview && send({ visitId, type: "publish", requestId: crypto.randomUUID(), previewId: preview.previewId, digest: preview.digest, acknowledgeExcludedHazards }),
    changeLink: (action: "create" | "extend" | "revoke" | "replace" | "copy", linkId?: string, expiresAt?: string) => send({ visitId, type: "link", requestId: crypto.randomUUID(), action, ...(linkId ? { linkId } : {}), ...(expiresAt ? { expiresAt } : {}) }),
    retry: () => pendingRef.current && send(pendingRef.current, true),
  };
}
