"use client";
import { useEffect, useRef, useState } from "react";
import { confirmedRO, photoAllowed, readROSession, removeROSession, safeLocalHref, saveROSession, submitFrozenRO, hasPendingCreates, MAX_PHOTOS, type ROSession, type JsonPost } from "./ro-session-store";
import { applySharedReceipt, deleteSharedDraft, draftFence, getSharedDraft, hydrateSharedDraft, sharedSnapshotSaved, SharedDraftError, uploadSharedPhoto, writeSharedDraft, type SharedDraft } from "./ro-shared-draft-client";
import { parseOdometerSuggestion, type DistanceUnit, type OdometerCapture } from "./ro-odometer";
import { checkInTransferRequest } from "./ro-shared-draft-client";

async function capability() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch("/api/dashboard/protractor/dvi-handoff", { credentials: "include", cache: "no-store", signal: controller.signal });
    const data = await response.json();
    if (!response.ok || !Number.isSafeInteger(data.shopId) || data.shopId <= 0 || typeof data.enabled !== "boolean" ||
        typeof data.actorKey !== "string" || !data.actorKey || data.actorKey.length > 200)
      throw new Error("Shop context could not be verified. Retry before creating an RO.");
    return data as { shopId: number; actorKey: string; enabled: boolean; sharedDrafts?: { version: number };
      odometerScan?: { version: number }; distanceUnit?: DistanceUnit };
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
export function useRORecovery(open: boolean, onCreated?: (number: number) => void, requestedDraftId?: string, requireSharedDraft = false) {
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
  const [sharedSupported, setSharedSupported] = useState(false);
  const [odometerSupported, setOdometerSupported] = useState(false);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit | null>(null);
  const [lastOdometerPhotoId, setLastOdometerPhotoId] = useState("");
  const [serverDraft, setServerDraft] = useState<SharedDraft | null>(null);
  const [sharedStatus, setSharedStatus] = useState<"local" | "saving" | "saved" | "unsynced" | "conflict">("local");
  const [localDraftExists, setLocalDraftExists] = useState(false);
  const deviceId = useRef("");
  const sharedCapability = useRef(false);
  const localOnlyChosen = useRef(false);
  const legacyPending = !!session && !session.shared && (localOnlyChosen.current || !!session.payload || hasPendingCreates(session));
  const sharedBlocked = !!serverDraft?.transfer || sharedStatus === "conflict" ||
    (!!session?.shared && session.shared.deviceId !== deviceId.current) ||
    (!!serverDraft && !legacyPending && (serverDraft.id !== session?.handoffRequestId ||
      (!!session?.shared && serverDraft.ownerDeviceId !== deviceId.current)));
  function adopt(value: ROSession) { current.current = value; setSession(value); }
  useEffect(() => {
    if (!open) { setReady(false); return; }
    // Reopening while a write is in flight waits for that write, then rechecks
    // identity. Never display another shop's old recovery screen.
    if (active.current) { reloadAfterActive.current = true; return; }
    const token = ++generation.current;
    setReady(false); setError(""); setSession(null); current.current = null;
    setServerDraft(null); setSharedStatus("local"); setLocalDraftExists(false);
    setLastOdometerPhotoId("");
    void (async () => {
      try {
        await draftWrites.current;
        const cap = await capability();
        const saved = await readROSession(cap.shopId, cap.actorKey);
        localOnlyChosen.current = !!saved && !saved.shared && (!!saved.payload || hasPendingCreates(saved));
        if (!deviceId.current) deviceId.current = crypto.randomUUID();
        sharedCapability.current = cap.enabled && cap.sharedDrafts?.version === 1;
        if ((requestedDraftId || requireSharedDraft) && !sharedCapability.current)
          throw new Error("Shared check-in requires current DVI access and enabled server drafts. No shared draft was opened and nothing was sent. Use the dashboard for the normal local repair order flow.");
        let remote: SharedDraft | null = null;
        if (sharedCapability.current) {
          try { remote = await getSharedDraft(cap, requestedDraftId); }
          catch (cause) {
            // Optional handoff outages must not strand a legacy local uncertain
            // request. Only an actual shared/mobile session depends on this API.
            if (saved?.shared || requestedDraftId || requireSharedDraft) throw cause;
            setError("Server check-in availability could not be checked. Your existing local repair order recovery remains available; phone handoff is not confirmed.");
          }
        }
        if (generation.current !== token) return;
        setSharedSupported(sharedCapability.current); setServerDraft(remote); setLocalDraftExists(!!saved);
        setOdometerSupported(sharedCapability.current && cap.odometerScan?.version === 1);
        setDistanceUnit(cap.distanceUnit === "miles" || cap.distanceUnit === "kilometers" ? cap.distanceUnit : null);
        const value = saved ?? { shopId: cap.shopId, actorKey: cap.actorKey, photos: [], handoffRequestId: crypto.randomUUID() };
        if (value.shopId !== cap.shopId || value.actorKey !== cap.actorKey || !Array.isArray(value.photos) || value.photos.length > MAX_PHOTOS ||
            value.photos.some(photo => !photo.missingOnDevice && !photoAllowed(photo.blob))) throw new Error("Saved arrival documentation is invalid. Creation is blocked; contact support.");
        if (value.payload) {
          const frozen = JSON.parse(value.payload);
          if (!frozen || typeof frozen !== "object" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(frozen.clientRequestId))
            throw new Error("Saved creation request is invalid. Do not create another RO; contact support.");
        }
        if (value.result && (!value.payload || !confirmedRO({ ...value.result, ok: true })))
          throw new Error("Saved confirmation is invalid. Do not create another RO; contact support.");
        setNeedsResume(!!saved && !saved.payload);
        if (value.shared && (!remote || remote.ownerDeviceId !== deviceId.current || remote.revision !== value.shared.revision))
          setSharedStatus("conflict");
        adopt(value); setEnabled(cap.enabled); setReady(true);
      } catch (cause) {
        if (generation.current === token) setError(cause instanceof Error ? cause.message : "RO recovery unavailable.");
      }
    })();
    return () => { generation.current++; };
  }, [open, attempt, requestedDraftId, requireSharedDraft]);
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
    setDistanceUnit(cap.distanceUnit === "miles" || cap.distanceUnit === "kilometers" ? cap.distanceUnit : null);
    if (value.shared && (!cap.enabled || value.shared.deviceId !== deviceId.current || cap.sharedDrafts?.version !== 1))
      throw new Error("Current DVI access and an explicitly resumed server draft are required before continuing. Nothing new was sent.");
    return cap;
  }
  function checkConfirmedOdometerUnit(value: ROSession, cap: { distanceUnit?: DistanceUnit }, reading: unknown) {
    if (!value.shared) return;
    const fields = JSON.parse(value.draft?.fields ?? "{}");
    if (fields.odometerCapture?.confirmed && fields.odometerCapture.confirmed.unit !== cap.distanceUnit)
      throw new Error("The shop's odometer unit changed or could not be verified. Review the original photo and explicitly confirm its converted reading again before creating a record.");
    if (fields.odometerCapture?.confirmed && Number(reading) !== fields.odometerCapture.confirmed.value)
      throw new Error("The odometer changed while this native request was being prepared. Review the confirmed reading and retry; no new record was sent.");
  }
  function sharedFailure(cause: unknown) {
    setSharedStatus(cause instanceof SharedDraftError && cause.status === 409 ? "conflict" : "unsynced");
  }
  async function synchronize(value: ROSession): Promise<ROSession> {
    if (!value.shared) return value;
    if (!sharedCapability.current || value.shared.deviceId !== deviceId.current)
      throw new Error("Shared check-in is not available here. Resume this draft explicitly; nothing new was sent.");
    setSharedStatus("saving");
    try {
      let remote = await writeSharedDraft("save", value, deviceId.current);
      let next = applySharedReceipt(value, remote, deviceId.current);
      // A save acknowledgement must not replace typing queued after its snapshot.
      function retainReceipt(receipt: ROSession) {
        const latest = current.current;
        adopt(latest?.handoffRequestId === receipt.handoffRequestId && !receipt.payload
          ? { ...receipt, draft: latest.draft } : receipt);
      }
      retainReceipt(next);
      for (const photo of next.photos) {
        if (photo.serverSaved) continue;
        remote = await uploadSharedPhoto(next, photo);
        next = applySharedReceipt(next, remote, deviceId.current);
        // Each confirmed binary acknowledgement is independently retained.
        const saved = await saveROSession(next);
        if (!saved.claimed) throw new Error("Another local recovery request must be resolved first.");
        retainReceipt(next);
      }
      setServerDraft(remote);
      setSharedStatus(sharedSnapshotSaved(current.current ?? next, remote) ? "saved" : "unsynced");
      return next;
    } catch (cause) { sharedFailure(cause); throw cause; }
  }
  async function refreshNativeFence() {
    const value = current.current!;
    if (!value.shared) return;
    try {
      const remote = await getSharedDraft(value, value.shared.id);
      if (!remote || remote.ownerDeviceId !== deviceId.current)
        throw new SharedDraftError("This check-in moved to another device. Resume its server copy before continuing.", 409);
      const next = applySharedReceipt(value, remote, deviceId.current);
      const retained = await saveROSession(next);
      if (!retained.claimed) throw new Error("A different local recovery request is retained. It has not been overwritten.");
      adopt(retained.session);
      setServerDraft(remote);
      setSharedStatus(sharedSnapshotSaved(retained.session, remote) ? "saved" : "unsynced");
    } catch (cause) { sharedFailure(cause); throw cause; }
  }
  const fencedPost: JsonPost = async (path, body) => {
    const value = current.current!;
    let result: Awaited<ReturnType<JsonPost>> | undefined;
    let failure: unknown;
    try { result = await post(path, { ...(body as Record<string, unknown>), ...draftFence(value) }); }
    catch (cause) { failure = cause; }
    // A server reservation can advance revision even when its native response is
    // absent or malformed. Always read; never replay to obtain a revision.
    await refreshNativeFence();
    const receipt = current.current;
    if (receipt?.shared && path.endsWith("/create-work-order") && receipt.result)
      return { ok: true, data: { ok: true, ...receipt.result } };
    if (receipt?.shared && path.endsWith("/arrival-photos")) {
      const photo = receipt.photos.find(p => p.requestId === (body as { requestId?: string }).requestId);
      if (photo?.uploaded) return { ok: true, data: { photo: photo.uploaded } };
    }
    if (result) return result;
    throw failure instanceof Error ? failure : new Error("The request response was lost. Its latest server revision was retained; verify the original request.");
  };
  async function persist(value: ROSession) {
    await draftWrites.current;
    if (!value.payload && current.current?.handoffRequestId === value.handoffRequestId)
      value = { ...value, draft: current.current.draft };
    // Carry the newest acknowledged fence, not a closure's earlier revision.
    if (value.shared && current.current?.shared?.id === value.shared.id)
      value = { ...value, shared: current.current.shared,
        ...(current.current.payload ? { payload: current.current.payload } : {}),
        ...(current.current.result ? { result: current.current.result } : {}) };
    const saved = await saveROSession(value);
    adopt(saved.session);
    if (!saved.claimed || saved.session.payload !== value.payload)
      throw new Error("Another saved RO owns this browser’s recovery slot. The existing request is preserved; verify it before continuing.");
    const next = await synchronize(saved.session);
    if (next.shared) {
      const retained = await saveROSession(next);
      if (!retained.claimed) throw new Error("The local recovery slot changed. Nothing new was sent.");
    }
    return next;
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
       if (photo.missingOnDevice) throw new Error("An arrival photo is not on this device or saved on the server. Save it from the original device before retrying.");
      const cap = await checkShop(next);
      if (!cap.enabled) throw new Error(`RO #${value.result.workOrderNumber} is confirmed. Arrival photos are retained on this device until DVI photo permission is restored. You may finish normally.`);
      const response = await fencedPost("/api/dashboard/protractor/arrival-photos", {
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
      const cap = await checkShop(value);
      checkConfirmedOdometerUnit(value, cap, payload.mileage);
      if (requireSharedDraft && !value.shared)
        throw new Error("Save this check-in to the server before creating the repair order. A different server draft will never be overwritten.");
      if (value.payload) throw new Error("An original creation request is already retained. Verify it instead.");
      if (hasPendingCreates(value)) throw new Error("Resolve pending customer or vehicle creation first.");
      const frozen = JSON.stringify(payload);
      if (frozen.length > 256 * 1024) throw new Error("RO details exceed safe local storage limits. Reduce job details.");
      const claim = await saveROSession({ ...value, payload: frozen }, true);
      adopt(claim.session);
      // A previously claimed request can only be recovered, even in another tab.
      const confirmed = await submitFrozenRO(claim.session, !claim.claimed, fencedPost, persist);
      const latest = { ...confirmed, result: current.current?.result ?? confirmed.result,
        shared: current.current?.shared, photos: current.current?.photos ?? confirmed.photos };
      adopt(latest); callback.current?.(confirmed.result!.workOrderNumber);
      await uploadPhotos(latest);
    });
  }
  function saveDraft(fields: string) {
    if (!ready || needsResume || sharedBlocked || !current.current || current.current.payload) return;
    const value = { ...current.current, draft: { version: 1 as const, fields } };
    if (value.shared) setSharedStatus("unsynced");
    const token = generation.current;
    current.current = value;
    draftWrites.current = draftWrites.current.then(async () => {
      if (fields.length > 256 * 1024) throw new Error("Draft is too large to save. Reduce job details before closing.");
      const saved = await saveROSession(value, false, true);
      if (!saved.claimed) throw new Error("Another tab owns this draft. Close and reopen to recover it.");
       if (value.shared) {
         // Local retention is immediate; shared writes coalesce behind typing.
         if (current.current?.draft?.fields !== fields) return;
         await new Promise(resolve => setTimeout(resolve, 350));
         if (current.current?.draft?.fields !== fields) return;
         const latest = current.current!;
         const next = await synchronize({ ...saved.session, shared: latest.shared });
         // Preserve newer typing queued behind this save.
         const latestFields = current.current?.draft;
         adopt({ ...next, draft: latestFields });
       }
    }).catch(cause => {
      if (generation.current === token) setError(cause instanceof Error ? cause.message : "Draft could not be saved.");
    });
  }
  async function prepareRelated(kind: "contact" | "vehicle", body: Record<string, unknown>, fields: string) {
    if (fields.length > 256 * 1024 || JSON.stringify(body).length > 256 * 1024)
      throw new Error("Draft is too large to preserve. Reduce details before creating a record.");
    await draftWrites.current;
    const value = current.current!;
    const cap = await checkShop(value);
    if (kind === "vehicle" && !value.pendingCreates?.vehicle) checkConfirmedOdometerUnit(value, cap, body.odometer);
    if (requireSharedDraft && !value.shared && !value.pendingCreates?.[kind])
      throw new Error("Save this check-in to the server before creating a customer or vehicle. Existing pending local requests must be recovered here first.");
    if (value.shared && value.pendingCreates?.[kind]) await refreshNativeFence();
    if (value.payload) throw new Error("Creation details are frozen.");
    const original = value.pendingCreates?.[kind] ?? body;
    const retained = await persist({ ...value, draft: { version: 1, fields },
      pendingCreates: { ...value.pendingCreates, [kind]: original } });
    return { ...original, ...draftFence(retained) };
  }
  async function finishRelated(kind: "contact" | "vehicle", fields: string) {
    await refreshNativeFence();
    const value = current.current!;
    const pendingCreates = { ...value.pendingCreates };
    delete pendingCreates[kind];
    // Selection and removal of the uncertain marker commit together.
    await draftWrites.current;
    const saved = await saveROSession({ ...value, pendingCreates, draft: { version: 1, fields } }, false, false, kind);
    if (!saved.claimed) throw new Error("The recovered selection could not be saved. Reopen to recover the original request.");
    adopt(saved.session);
    const next = await synchronize(saved.session);
    if (next.shared) await saveROSession(next);
  }
  async function resumeDraft(): Promise<ROSession | null> {
    let restored: ROSession | null = null;
    await run(async () => {
      await checkShop(current.current!);
      restored = current.current!;
      if (!restored.shared) localOnlyChosen.current = true;
    });
    return restored;
  }
  function discardDraft() {
    return run(async () => {
      const value = current.current!;
      await checkShop(value);
      if (value.payload || hasPendingCreates(value)) throw new Error("Submitted requests cannot be discarded.");
      await deleteSharedDraft(value);
      await removeROSession(value);
      adopt({ shopId: value.shopId, actorKey: value.actorKey, photos: [], handoffRequestId: crypto.randomUUID() });
      localOnlyChosen.current = false;
      setLocalDraftExists(false); if (value.shared) setServerDraft(null); setSharedStatus("local");
      setNeedsResume(false);
    });
  }
  function verify() {
    return run(async () => {
      const value = current.current!;
      await checkShop(value);
      const confirmed = await submitFrozenRO(value, true, fencedPost, persist);
      const latest = { ...confirmed, result: current.current?.result ?? confirmed.result,
        shared: current.current?.shared, photos: current.current?.photos ?? confirmed.photos };
      adopt(latest); callback.current?.(confirmed.result!.workOrderNumber);
      await uploadPhotos(latest);
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
    try { await checkShop(current.current); await deleteSharedDraft(current.current); await removeROSession(current.current); current.current = null; setSession(null); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not finish this RO."); return false; }
  }
  function shareDraft(fields: string) {
    return run(async () => {
      const value = current.current!;
      const cap = await checkShop(value);
      if (!cap.enabled || cap.sharedDrafts?.version !== 1 || !sharedCapability.current)
        throw new Error("Shared check-in requires current DVI access and enabled server drafts.");
      if (value.payload || hasPendingCreates(value)) throw new Error("Resolve the retained native creation request before moving a local-only draft to the server.");
      if (fields.length > 256 * 1024) throw new Error("Draft exceeds safe storage limits.");
      let next = await persist({ ...value, draft: { version: 1, fields } });
      if (!next.shared) {
        const remote = await writeSharedDraft("create", next, deviceId.current);
        next = applySharedReceipt(next, remote, deviceId.current);
        adopt(next);
        const saved = await saveROSession(next);
        if (!saved.claimed) throw new Error("Another saved request owns this device. Resolve it first.");
        setServerDraft(remote);
      }
      next = await synchronize(next);
      await saveROSession(next); adopt(next);
    });
  }
  async function resumeSharedDraft(): Promise<ROSession | null> {
    let result: ROSession | null = null;
    await run(async () => {
      const local = current.current!;
      if (!sharedCapability.current || !serverDraft) throw new Error("No server draft is available. Refresh to check again.");
      const retained = await readROSession(local.shopId, local.actorKey);
      if ((localDraftExists && local.handoffRequestId !== serverDraft.id) || (retained && retained.handoffRequestId !== serverDraft.id))
        throw new Error("This browser has a different retained draft. Explicitly discard it, or finish its pending requests, before resuming the server draft.");
      const remote = await writeSharedDraft("claim", local, deviceId.current, serverDraft);
      const restored = await hydrateSharedDraft(remote, deviceId.current);
      let saved = await saveROSession(restored);
      if (!saved.claimed) throw new Error("A different local draft is retained. It has not been overwritten.");
      // IndexedDB deliberately preserves uncertain markers. Only an explicit
      // server resume with its authoritative recovered selection can clear one.
      for (const kind of ["contact", "vehicle"] as const) {
        if (saved.session.pendingCreates?.[kind] && !restored.pendingCreates?.[kind]) {
          const fields = JSON.parse(restored.draft?.fields ?? "{}");
          if (!fields[kind === "contact" ? "selectedContact" : "selectedVehicle"]?.id)
            throw new Error("A local native request is not resolved in the server snapshot. Keep the original request and verify it before replacing this device copy.");
          saved = await saveROSession(restored, false, false, kind);
          if (!saved.claimed) throw new Error("The recovered native selection could not be retained on this device.");
        }
      }
      adopt(saved.session); setServerDraft(remote); setSharedStatus(sharedSnapshotSaved(saved.session, remote) ? "saved" : "unsynced");
      localOnlyChosen.current = false;
      setNeedsResume(false); setLocalDraftExists(true); result = saved.session;
    });
    return result;
  }
  function refreshSharedDraft() {
    return run(async () => {
      if (!sharedCapability.current) return;
      setServerDraft(await getSharedDraft(current.current!, requestedDraftId));
    });
  }
  function transferDraft(action:"offer"|"cancel",fields:string,email?:string) {
    return run(async()=>{
      await draftWrites.current;
      let value=current.current!;
      await checkShop(value);
      if(!value.shared)throw new Error("Save the check-in to the server first.");
      if(action==="offer"){
        value=await persist({...value,draft:{version:1,fields}});
      }
      const remote=action==="cancel"?await getSharedDraft(value,value.shared!.id):serverDraft;
      const result=await checkInTransferRequest("",{action,...value.shared,
        ...(action==="cancel"&&remote?{revision:remote.revision}:{}),...(email?{email}:{})});
      setServerDraft(result.draft);
      adopt(applySharedReceipt(value,result.draft,deviceId.current));
      setSharedStatus("saved");
    });
  }
  async function scanOdometer(file: File): Promise<Pick<OdometerCapture, "photoRequestId" | "suggestion"> | null> {
    let result: Pick<OdometerCapture, "photoRequestId" | "suggestion"> | null = null;
    await run(async () => {
      const value = current.current!;
      const cap = await checkShop(value);
      if (cap.odometerScan?.version !== 1 || !value.shared || !cap.enabled)
        throw new Error("Odometer interpretation requires an enabled server draft and arrival photo access. Enter mileage manually instead.");
      if (value.payload || !photoAllowed(file) || value.photos.length >= MAX_PHOTOS)
        throw new Error("Choose a JPEG, PNG or WebP photo up to 4 MiB before creation. A draft can retain up to 12 photos.");
      const photoRequestId = crypto.randomUUID();
      // Retain the original before paid interpretation; failures never remove it.
      const saved = await persist({ ...value, photos: [...value.photos, { requestId: photoRequestId, blob: file, name: file.name }] });
      setLastOdometerPhotoId(photoRequestId);
      const response = await fencedPost("/api/dashboard/protractor/odometer-ocr", { ...draftFence(saved), photoRequestId,
        interpretationRequestId: photoRequestId });
      if (!response.ok) throw new Error("Odometer reading is unavailable. The original photo is retained and your previous mileage is unchanged.");
      result = { photoRequestId, suggestion: parseOdometerSuggestion((response.data as { result?: unknown }).result) };
    });
    return result;
  }
  async function readSavedOdometer(photoRequestId: string): Promise<Pick<OdometerCapture, "photoRequestId" | "suggestion"> | null> {
    let result: Pick<OdometerCapture, "photoRequestId" | "suggestion"> | null = null;
    await run(async () => {
      const value = current.current!, cap = await checkShop(value);
      if (!value.shared || !cap.enabled || cap.odometerScan?.version !== 1 || value.payload ||
        !value.photos.some(photo => photo.requestId === photoRequestId && photo.serverSaved))
        throw new Error("Choose an arrival photo already saved to this shared check-in before creation.");
      setLastOdometerPhotoId(photoRequestId);
      const response = await fencedPost("/api/dashboard/protractor/odometer-ocr", { photoRequestId,
        interpretationRequestId: photoRequestId });
      if (!response.ok) throw new Error("The existing photo reading is not confirmed. Its exact identity is retained; previous mileage is unchanged.");
      result = { photoRequestId, suggestion: parseOdometerSuggestion((response.data as { result?: unknown }).result) };
    });
    return result;
  }
  return { session, enabled, ready, busy, error, needsResume, saveDraft, resumeDraft, discardDraft,
    sharedSupported, serverDraft, sharedStatus, sharedBlocked, localDraftExists, shareDraft, resumeSharedDraft, refreshSharedDraft, transferDraft,
    refreshAfterNative: refreshNativeFence,
    odometerSupported, distanceUnit, scanOdometer, readSavedOdometer, lastOdometerPhotoId,
    prepareRelated, finishRelated,
    acceptDraft: () => setNeedsResume(false), checkContext: () => checkShop(current.current!), create, verify, addPhoto, removePhoto, retryPhotos, continueDvi, finish,
    reload: () => setAttempt(value => value + 1) };
}
