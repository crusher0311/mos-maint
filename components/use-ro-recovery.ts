"use client";
import { useEffect, useRef, useState } from "react";
import { confirmedRO, photoAllowed, readROSession, removeROSession, safeLocalHref, saveROSession, submitFrozenRO, hasPendingCreates, MAX_PHOTOS, type ROSession, type JsonPost } from "./ro-session-store";

async function capability() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch("/api/dashboard/protractor/dvi-handoff", { credentials: "include", cache: "no-store", signal: controller.signal });
    const data = await response.json();
    if (!response.ok || !Number.isSafeInteger(data.shopId) || data.shopId <= 0 || typeof data.enabled !== "boolean" ||
        typeof data.actorKey !== "string" || !data.actorKey || data.actorKey.length > 200)
      throw new Error("Shop context could not be verified. Retry before creating an RO.");
    return data as { shopId: number; actorKey: string; enabled: boolean };
  } finally { clearTimeout(timer); }
}
const post: JsonPost = async (path, body) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal });
    return { ok: response.ok, data: await response.json() };
  } finally { clearTimeout(timer); }
};
function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Arrival photo could not be read."));
    reader.readAsDataURL(blob);
  });
}
export function useRORecovery(open: boolean, onCreated?: (number: number) => void) {
  const [session, setSession] = useState<ROSession | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const active = useRef(false);
  const reloadAfterActive = useRef(false);
  const current = useRef<ROSession | null>(null);
  const callback = useRef(onCreated);
  callback.current = onCreated;
  const generation = useRef(0);
  const draftWrites = useRef(Promise.resolve());
  const [needsResume, setNeedsResume] = useState(false);
  function adopt(value: ROSession) { current.current = value; setSession(value); }
  useEffect(() => {
    if (!open) { setReady(false); return; }
    // Reopening while a write is in flight waits for that write, then rechecks
    // identity. Never display another shop's old recovery screen.
    if (active.current) { reloadAfterActive.current = true; return; }
    const token = ++generation.current;
    setReady(false); setError(""); setSession(null); current.current = null;
    void (async () => {
      try {
        await draftWrites.current;
        const cap = await capability();
        const saved = await readROSession(cap.shopId, cap.actorKey);
        if (generation.current !== token) return;
        const value = saved ?? { shopId: cap.shopId, actorKey: cap.actorKey, photos: [], handoffRequestId: crypto.randomUUID() };
        if (value.shopId !== cap.shopId || value.actorKey !== cap.actorKey || !Array.isArray(value.photos) || value.photos.length > MAX_PHOTOS ||
            value.photos.some(photo => !photoAllowed(photo.blob))) throw new Error("Saved arrival documentation is invalid. Creation is blocked; contact support.");
        if (value.payload) {
          const frozen = JSON.parse(value.payload);
          if (!frozen || typeof frozen !== "object" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(frozen.clientRequestId))
            throw new Error("Saved creation request is invalid. Do not create another RO; contact support.");
        }
        if (value.result && (!value.payload || !confirmedRO({ ...value.result, ok: true })))
          throw new Error("Saved confirmation is invalid. Do not create another RO; contact support.");
        setNeedsResume(!!saved && !saved.payload);
        adopt(value); setEnabled(cap.enabled); setReady(true);
      } catch (cause) {
        if (generation.current === token) setError(cause instanceof Error ? cause.message : "RO recovery unavailable.");
      }
    })();
    return () => { generation.current++; };
  }, [open, attempt]);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  async function checkShop(value: ROSession) {
    const cap = await capability();
    if (cap.shopId !== value.shopId || cap.actorKey !== value.actorKey) {
      setReady(false);
      throw new Error("The active shop or signed-in advisor changed. Close and reopen New Work Order to recover the matching draft. Nothing was sent.");
    }
    setEnabled(cap.enabled);
    return cap;
  }
  async function persist(value: ROSession) {
    await draftWrites.current;
    if (!value.payload && current.current?.handoffRequestId === value.handoffRequestId)
      value = { ...value, draft: current.current.draft };
    const saved = await saveROSession(value);
    adopt(saved.session);
    if (!saved.claimed || saved.session.payload !== value.payload)
      throw new Error("Another saved RO owns this browser’s recovery slot. The existing request is preserved; verify it before continuing.");
    return saved.session;
  }
  async function run(action: () => Promise<void>) {
    if (active.current || !ready) return;
    active.current = true; setBusy(true); setError("");
    try { await draftWrites.current; await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Request failed. Your original RO and photos are retained."); }
    finally {
      active.current = false; setBusy(false);
      if (reloadAfterActive.current) { reloadAfterActive.current = false; setAttempt(value => value + 1); }
    }
  }
  async function uploadPhotos(value: ROSession) {
    if (!value.result) return;
    let next = value;
    for (const photo of value.photos) {
      if (photo.uploaded) continue;
      const cap = await checkShop(next);
      if (!cap.enabled) throw new Error(`RO #${value.result.workOrderNumber} is confirmed. Arrival photos are retained on this device until DVI photo permission is restored. You may finish normally.`);
      const response = await post("/api/dashboard/protractor/arrival-photos", {
        requestId: photo.requestId, workOrderId: value.result.workOrderId, mime: photo.blob.type, base64: await base64(photo.blob),
      });
      const data = response.data as { photo?: { id: string; mime: string; url: string } };
      if (!response.ok || !data?.photo?.id || !safeLocalHref(data.photo.url) || data.photo.mime !== photo.blob.type)
        throw new Error(`RO #${value.result.workOrderNumber} is confirmed, but an arrival upload is not confirmed. Retry photos only.`);
      next = await persist({ ...next, photos: next.photos.map(entry => entry.requestId === photo.requestId ? { ...entry, uploaded: data.photo } : entry) });
    }
  }
  function create(payload: Record<string, unknown>) {
    return run(async () => {
      const value = current.current!;
      await checkShop(value);
      if (value.payload) throw new Error("An original creation request is already retained. Verify it instead.");
      if (hasPendingCreates(value)) throw new Error("Resolve pending customer or vehicle creation first.");
      const frozen = JSON.stringify(payload);
      if (frozen.length > 256 * 1024) throw new Error("RO details exceed safe local storage limits. Reduce job details.");
      const claim = await saveROSession({ ...value, payload: frozen }, true);
      adopt(claim.session);
      // A previously claimed request can only be recovered, even in another tab.
      const confirmed = await submitFrozenRO(claim.session, !claim.claimed, post, persist);
      adopt(confirmed); callback.current?.(confirmed.result!.workOrderNumber);
      await uploadPhotos(confirmed);
    });
  }
  function saveDraft(fields: string) {
    if (!ready || needsResume || !current.current || current.current.payload) return;
    const value = { ...current.current, draft: { version: 1 as const, fields } };
    const token = generation.current;
    current.current = value;
    draftWrites.current = draftWrites.current.then(async () => {
      if (fields.length > 256 * 1024) throw new Error("Draft is too large to save. Reduce job details before closing.");
      const saved = await saveROSession(value, false, true);
      if (!saved.claimed) throw new Error("Another tab owns this draft. Close and reopen to recover it.");
    }).catch(cause => {
      if (generation.current === token) setError(cause instanceof Error ? cause.message : "Draft could not be saved.");
    });
  }
  async function prepareRelated(kind: "contact" | "vehicle", body: Record<string, unknown>, fields: string) {
    if (fields.length > 256 * 1024 || JSON.stringify(body).length > 256 * 1024)
      throw new Error("Draft is too large to preserve. Reduce details before creating a record.");
    await draftWrites.current;
    const value = current.current!;
    await checkShop(value);
    if (value.payload) throw new Error("Creation details are frozen.");
    const original = value.pendingCreates?.[kind] ?? body;
    await persist({ ...value, draft: { version: 1, fields },
      pendingCreates: { ...value.pendingCreates, [kind]: original } });
    return original;
  }
  async function finishRelated(kind: "contact" | "vehicle", fields: string) {
    const value = current.current!;
    const pendingCreates = { ...value.pendingCreates };
    delete pendingCreates[kind];
    // Selection and removal of the uncertain marker commit together.
    await draftWrites.current;
    const saved = await saveROSession({ ...value, pendingCreates, draft: { version: 1, fields } }, false, false, kind);
    if (!saved.claimed) throw new Error("The recovered selection could not be saved. Reopen to recover the original request.");
    adopt(saved.session);
  }
  async function resumeDraft(): Promise<ROSession | null> {
    let restored: ROSession | null = null;
    await run(async () => {
      await checkShop(current.current!);
      restored = current.current!;
    });
    return restored;
  }
  function discardDraft() {
    return run(async () => {
      const value = current.current!;
      await checkShop(value);
      if (value.payload || hasPendingCreates(value)) throw new Error("Submitted requests cannot be discarded.");
      await removeROSession(value);
      adopt({ shopId: value.shopId, actorKey: value.actorKey, photos: [], handoffRequestId: crypto.randomUUID() });
      setNeedsResume(false);
    });
  }
  function verify() {
    return run(async () => {
      const value = current.current!;
      await checkShop(value);
      const confirmed = await submitFrozenRO(value, true, post, persist);
      adopt(confirmed); callback.current?.(confirmed.result!.workOrderNumber);
      await uploadPhotos(confirmed);
    });
  }
  function addPhoto(file: File) {
    return run(async () => {
      const value = current.current!;
      if (value.payload) throw new Error("Creation details are frozen.");
      if (!photoAllowed(file)) throw new Error("Choose a JPEG, PNG or WebP photo up to 4 MB.");
      if (value.photos.length >= MAX_PHOTOS) throw new Error(`Up to ${MAX_PHOTOS} arrival photos can be retained.`);
      const cap = await checkShop(value);
      if (!cap.enabled) throw new Error("Arrival photo uploads require DVI access. You can still create a repair order normally.");
      await persist({ ...value, photos: [...value.photos, { requestId: crypto.randomUUID(), blob: file, name: file.name }] });
    });
  }
  function removePhoto(requestId: string) {
    return run(async () => {
      const value = current.current!;
      if (!value.payload) await persist({ ...value, photos: value.photos.filter(photo => photo.requestId !== requestId) });
    });
  }
  function retryPhotos() { return run(async () => { await uploadPhotos(current.current!); }); }
  function continueDvi() {
    return run(async () => {
      const value = current.current!;
      if (!value.result || value.photos.some(photo => !photo.uploaded)) return;
      const cap = await checkShop(value);
      if (!cap.enabled) throw new Error("DVI access is no longer enabled. Your confirmed RO is unchanged.");
      const response = await post("/api/dashboard/protractor/dvi-handoff", { requestId: value.handoffRequestId,
        workOrderId: value.result.workOrderId, workOrderNumber: value.result.workOrderNumber });
      const data = response.data as { visitId?: string; href?: string };
      if (!response.ok || typeof data?.visitId !== "string" || !data.visitId || !safeLocalHref(data.href))
        throw new Error("DVI handoff is not confirmed. Retry Continue to DVI; the RO will not be recreated.");
      window.location.assign(data.href);
    });
  }
  async function finish(): Promise<boolean> {
    if (active.current || !ready || !current.current?.result || current.current.photos.some(photo => !photo.uploaded)) return false;
    try { await checkShop(current.current); await removeROSession(current.current); current.current = null; setSession(null); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not finish this RO."); return false; }
  }
  return { session, enabled, ready, busy, error, needsResume, saveDraft, resumeDraft, discardDraft,
    prepareRelated, finishRelated,
    acceptDraft: () => setNeedsResume(false), checkContext: () => checkShop(current.current!), create, verify, addPhoto, removePhoto, retryPhotos, continueDvi, finish,
    reload: () => setAttempt(value => value + 1) };
}
